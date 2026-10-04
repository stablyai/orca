import { randomUUID } from 'node:crypto'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent,
  StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  AgentSessionPreSpawnError,
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { codexSpawnedProcessIdentity } from '../codex/codex-structured-owner-identity'
import { isCodexAppServerHandshakeExitUnprovenError } from '../codex/codex-app-server-handshake-exit-proof'
import { createCursorAcpSession } from './cursor-acp-session'
import { openCursorAcpConnection, type CursorAcpLaunch } from './cursor-acp-connection'
import { dispatchCursorStructuredMessage } from './cursor-structured-dispatch'
import { CursorAcpPrompts } from './cursor-acp-prompts'
import { CursorAcpOptions, CursorAcpOptionUnavailableError } from './cursor-acp-options'
import { CursorAcpJournal } from './cursor-acp-journal'

export { supportsCursorStructuredLocation } from './cursor-structured-location-support'
import { supportsCursorStructuredLocation } from './cursor-structured-location-support'

export type CursorStructuredLaunch = CursorAcpLaunch & { cwd: string; resumeSessionId?: string }
export type CursorStructuredSessionAdapterDeps = {
  resolveLaunch: (input: StructuredAgentSessionAcquireInput) => Promise<CursorStructuredLaunch>
  onLifecycleEvent: (event: StructuredAgentSessionLifecycleEvent) => void
  onDispatchSettledLate: (
    settlement: Parameters<StructuredAgentSessionHost['settleLateDispatch']>[0]
  ) => void
  openConnection?: typeof openCursorAcpConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
}

import type { CursorStructuredOwner as CursorOwner } from './cursor-structured-owner'

export class CursorStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly owners = new Map<string, CursorOwner>()
  private readonly acquiring = new Set<string>()
  private closing = false

  constructor(private readonly deps: CursorStructuredSessionAdapterDeps) {}
  supportsLocation = supportsCursorStructuredLocation

  async acquire(input: StructuredAgentSessionAcquireInput) {
    const sessionId = input.identity.sessionId
    if (this.closing || this.acquiring.has(sessionId) || this.owners.has(sessionId)) {
      throw new AgentSessionPreSpawnError('Cursor session already has an owner or is closing')
    }
    this.acquiring.add(sessionId)
    let owner: CursorOwner | null = null
    let spawnedObserved = false
    try {
      const launch = await this.deps.resolveLaunch(input).catch((error: unknown) => {
        throw new AgentSessionPreSpawnError(error)
      })
      if (this.closing) {
        throw new AgentSessionPreSpawnError('Cursor adapter closed during launch preparation')
      }
      const journal = new CursorAcpJournal(() => owner?.providerSessionId ?? '', input.events)
      const prompts = new CursorAcpPrompts(
        () => {
          if (!owner?.connection) {
            throw new Error('Cursor transport unavailable')
          }
          return owner.connection
        },
        () => owner?.providerSessionId ?? '',
        (identity, body) => journal.append(identity, body)
      )
      owner = {
        fence: input.fence,
        generation: randomUUID(),
        session: null,
        connection: null,
        providerSessionId: launch.resumeSessionId ?? '',
        journal,
        prompts,
        options: new CursorAcpOptions(),
        optionRestoreFailures: [],
        pending: null,
        ended: false,
        stopped: false
      }
      this.owners.set(sessionId, owner)
      const current = owner
      const spawned = codexSpawnedProcessIdentity(input, this.deps.readProcessStartTime)
      const session = await createCursorAcpSession({
        launch: {
          ...launch,
          env: {
            ...launch.env,
            ORCA_AGENT_SESSION_SPAWN_TOKEN: input.spawnToken,
            ORCA_AGENT_SESSION_ID: sessionId
          }
        },
        cwd: launch.cwd,
        ...(launch.resumeSessionId === undefined ? {} : { sessionId: launch.resumeSessionId }),
        onSpawned: async (pid) => {
          spawnedObserved = true
          await spawned.onSpawned(pid)
        },
        openConnection: async (spec, handlers) => {
          const connection = await (this.deps.openConnection ?? openCursorAcpConnection)(
            spec,
            handlers
          )
          current.connection = connection
          current.unbindReading = input.events?.bindReadingControl?.({
            pauseReading: () => connection.pauseReading?.(),
            resumeReading: () => connection.resumeReading?.()
          })
          return connection
        },
        events: {
          ready: (id, _connection, state) => {
            current.providerSessionId = id
            current.options.state(state)
          },
          update: (update, replay) => {
            if (current.ended || this.owners.get(sessionId) !== current) {
              return
            }
            current.options.update(update)
            if (current.journal.update(update, replay) && !replay) {
              this.acceptPending(sessionId, current)
            }
          },
          request: (request) => {
            if (current.prompts.receive(request)) {
              this.acceptPending(sessionId, current)
            }
          },
          exit: (error) => {
            if (current.session && !current.stopped) {
              this.reportExit(sessionId, current, error)
            }
          }
        }
      })
      current.session = session
      for (const [key, value] of Object.entries(input.options ?? {})) {
        try {
          await current.options.set(session.connection, session.sessionId, key, value)
        } catch (error) {
          if (!(error instanceof CursorAcpOptionUnavailableError)) {
            throw error
          }
          current.optionRestoreFailures.push(key)
        }
      }
      if (this.closing || current.ended) {
        throw new Error('Cursor owner ended during acquisition')
      }
      return {
        process: await spawned.read(session.connection.pid),
        acquisitionGeneration: current.generation,
        link: {
          linkId: randomUUID(),
          handle: { provider: 'cursor' as const, sessionId: session.sessionId },
          origin:
            launch.resumeSessionId === undefined ? ('created' as const) : ('resumed' as const),
          mintedAtFence: input.fence,
          observedAt: Date.now()
        }
      }
    } catch (error) {
      if (owner && isCodexAppServerHandshakeExitUnprovenError(error)) {
        owner.retryClose = error.connection.close
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
      if (owner?.connection) {
        if (!(await owner.connection.close())) {
          throw new AgentSessionAcquisitionExitUnprovenError(error)
        }
        owner.unbindReading?.()
        owner.prompts.clear()
        this.owners.delete(sessionId)
        throw new AgentSessionAcquisitionExitProvenError(error)
      }
      this.owners.delete(sessionId)
      if (spawnedObserved) {
        throw new AgentSessionAcquisitionExitProvenError(error)
      }
      throw new AgentSessionPreSpawnError(error)
    } finally {
      this.acquiring.delete(sessionId)
    }
  }

  private acceptPending(sessionId: string, owner: CursorOwner): void {
    if (this.owners.get(sessionId) !== owner || owner.ended || owner.stopped) {
      return
    }
    const pending = owner.pending
    if (!pending) {
      return
    }
    owner.pending = null
    this.deps.onDispatchSettledLate({ sessionId, ...pending })
  }

  private reportExit(sessionId: string, owner: CursorOwner, error: Error): void {
    if (owner.ended || this.owners.get(sessionId) !== owner) {
      return
    }
    owner.ended = true
    owner.prompts.clear()
    owner.unbindReading?.()
    this.deps.onLifecycleEvent({
      type: 'ended',
      sessionId,
      reason: error.message,
      cause: 'unexpected-exit',
      fence: owner.fence,
      acquisitionGeneration: owner.generation,
      observedAt: Date.now()
    })
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    dispatchCursorStructuredMessage(
      input,
      this.owner.bind(this),
      this.acceptPending.bind(this),
      this.reportExit.bind(this),
      this.deps.onDispatchSettledLate
    )

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const owner = this.owner(input.sessionId, input.fence)
    if (input.turnId && input.turnId !== owner.journal.turnId) {
      return { cancelled: false }
    }
    return { cancelled: (await owner.session?.cancel()) ?? false }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.owner(input.sessionId, input.fence).prompts.answer(input)
  setOption: StructuredAgentSessionAdapter['setOption'] = async (input) => {
    const owner = this.owner(input.sessionId, input.fence)
    if (!owner.connection) {
      throw new Error('Cursor ACP transport unavailable')
    }
    return owner.options.set(owner.connection, owner.providerSessionId, input.key, input.value)
  }
  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = async (input) =>
    this.owner(input.sessionId, input.fence).options.read()
  readOptionRestoreFailures = (sessionId: string): readonly string[] =>
    this.owners.get(sessionId)?.optionRestoreFailures ?? []
  readCommands = (sessionId: string) => this.owners.get(sessionId)?.options.readCommands()
  holdsDispatch = (sessionId: string): boolean => {
    const owner = this.owners.get(sessionId)
    return Boolean(owner?.pending && owner.session?.phase !== 'ready')
  }

  closeSession = async (sessionId: string): Promise<boolean> => {
    const owner = this.owners.get(sessionId)
    if (!owner) {
      return false
    }
    owner.stopped = true
    if (!(await (owner.retryClose?.() ?? owner.connection?.close()))) {
      return false
    }
    owner.ended = true
    owner.prompts.clear()
    owner.unbindReading?.()
    return true
  }
  forceCloseSession = async (sessionId: string): Promise<boolean> => {
    const owner = this.owners.get(sessionId)
    if (!owner) {
      return false
    }
    if (!(await (owner.retryClose?.() ?? owner.connection?.close()))) {
      return false
    }
    this.reportExit(sessionId, owner, new Error('Cursor journal stopped accepting provider events'))
    return true
  }
  disposeSession = this.closeSession
  releaseAcquisition = (input: { sessionId: string }) => this.closeSession(input.sessionId)
  acknowledgeSessionRelease = (sessionId: string): void => {
    this.owners.delete(sessionId)
  }
  closeAll = async (): Promise<void> => {
    this.closing = true
    const results = await Promise.all([...this.owners.keys()].map(this.closeSession))
    if (results.some((closed) => !closed) || this.acquiring.size) {
      throw new Error('Cursor process exit is unproven')
    }
  }

  private owner(sessionId: string, fence: number): CursorOwner {
    const owner = this.owners.get(sessionId)
    if (!owner || owner.fence !== fence || owner.ended || owner.stopped || !owner.session) {
      throw new Error('Cursor ACP session has no matching live owner')
    }
    return owner
  }
}
