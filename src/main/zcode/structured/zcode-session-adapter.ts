/** The ZCode chat adapter: builds one hosted session per chat and routes the host's calls to it. */

import type { AgentSessionProcessIdentity } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionSetOptionInput
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionCancelOutcome } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-stop'
import {
  AgentSessionStartEndings,
  agentSessionStartFailure,
  type AgentSessionStartAnswer
} from '../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import {
  AgentSessionPreSpawnError,
  AgentSessionPromptUnavailableError,
  isAgentSessionPreSpawnError,
  launchPreparationFailure
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { AgentSessionAcquisitionExitUnprovenError } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'
import { ProviderAcquisitionStarts } from '../../provider-process/provider-acquisition-starts'
import { providerSpawnedProcessIdentity } from '../../provider-process/provider-spawned-process-identity'
import { supportsSupervisedProviderChildLocation } from '../../provider-process/supervised-provider-child-location'
import { waitForPromiseWithSignal } from '../../../shared/concurrency/abort-signal-reason'
import {
  ZcodeAnchor,
  ZcodeHostedSession,
  type ZcodeAdapterDeps,
  type ZcodeComposedLaunch
} from './zcode-hosted-session'

export type { ZcodeAdapterDeps, ZcodeComposedLaunch } from './zcode-hosted-session'

// ZCode declares no temporary startup answers; only its process's own exit leaves a start unanswered.
const ZCODE_START_ANSWER: AgentSessionStartAnswer = () => undefined

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ZcodeHostedSession>()
  private readonly acquiring = new Set<string>()
  private readonly starts = new ProviderAcquisitionStarts<ZcodeAnchor>()
  private readonly endings = new AgentSessionStartEndings()

  constructor(private readonly deps: ZcodeAdapterDeps) {}

  supportsLocation = supportsSupervisedProviderChildLocation

  supportsCreate: NonNullable<StructuredAgentSessionAdapter['supportsCreate']> = (
    location,
    agent
  ) => agent === 'zcode' && this.supportsLocation(location)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    if (this.acquiring.has(sessionId) || this.sessions.has(sessionId)) {
      throw new AgentSessionPreSpawnError(new Error('ZCode chat already owns a process'))
    }
    this.acquiring.add(sessionId)
    const attempt = this.starts.begin(input.signal)
    try {
      if (!(await this.starts.stopFailed(sessionId))) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error('Previous ZCode start has not exited')
        )
      }
      let launch: ZcodeComposedLaunch
      try {
        launch = await waitForPromiseWithSignal(
          this.deps.resolveLaunch({ identity: input.identity, spawnToken: input.spawnToken }),
          attempt.signal
        )
      } catch (error) {
        throw attempt.signal.aborted
          ? new AgentSessionPreSpawnError(error)
          : launchPreparationFailure(error)
      }
      if (attempt.signal.aborted) {
        throw new AgentSessionPreSpawnError(new Error('ZCode chat closed while starting'))
      }
      const anchor = new ZcodeAnchor(launch)
      this.starts.track(attempt, anchor)
      const session = new ZcodeHostedSession(input, anchor, this.deps, launch)
      this.endings.admit(sessionId, session.generation)
      anchor.onExit(() => {
        if (session.live) {
          this.endings.record(
            sessionId,
            session.generation,
            agentSessionStartFailure(
              new Error('ZCode anchor exited while starting'),
              ZCODE_START_ANSWER,
              true
            )
          )
        }
      })
      const spawned = providerSpawnedProcessIdentity(
        {
          identity: input.identity,
          spawnToken: input.spawnToken,
          ...(input.onSpawned ? { onSpawned: input.onSpawned } : {})
        },
        'ZCode',
        this.deps.readProcessStartTime
      )
      const pid = anchor.pid
      if (pid !== undefined) {
        await spawned.onSpawned(pid)
      }
      const process: AgentSessionProcessIdentity = await spawned.read(pid)
      this.sessions.set(sessionId, session)
      return { process, acquisitionGeneration: session.generation }
    } catch (error) {
      if (
        isAgentSessionPreSpawnError(error) ||
        error instanceof AgentSessionAcquisitionExitUnprovenError
      ) {
        throw error
      }
      throw agentSessionStartFailure(error, ZCODE_START_ANSWER)
    } finally {
      this.starts.end(attempt)
      this.acquiring.delete(sessionId)
    }
  }

  open: NonNullable<StructuredAgentSessionAdapter['open']> = (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.generation !== input.acquisitionGeneration) {
      const ending = this.endings.get(input.sessionId, input.acquisitionGeneration)
      return Promise.reject(ending ?? new Error('ZCode chat changed before it opened'))
    }
    return Promise.resolve(session.open(input.signal))
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || !session.live) {
      return { state: 'unknown', reason: 'ZCode chat is not running' }
    }
    return session.dispatch(
      zcodePromptText(input.body),
      input.clientMessageId,
      input.requestedAt ?? Date.now()
    )
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      return { cancelled: false }
    }
    session.cancel()
    const outcome: AgentSessionCancelOutcome = { cancelled: true }
    return outcome
  }

  setOption: StructuredAgentSessionAdapter['setOption'] = async (
    input: StructuredAgentSessionSetOptionInput
  ) => {
    const session = this.sessions.get(input.sessionId)
    return session ? session.applyOption(input.key, input.value) : {}
  }

  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = async (input) => {
    const saved = this.sessions.get(input.sessionId)?.optionsSnapshot() ?? {}
    return {
      models: [],
      current: {
        ...(saved.model ? { model: saved.model } : {}),
        ...(saved.effort ? { effort: saved.effort } : {})
      }
    }
  }

  // ZCode enforces permissions itself and emits no approval or question prompts.
  answerPrompt: NonNullable<StructuredAgentSessionAdapter['answerPrompt']> = (input) =>
    Promise.reject(new AgentSessionPromptUnavailableError(input.itemId))

  holdsLiveProviderProcess = (sessionId: string): boolean =>
    this.sessions.get(sessionId)?.live === true

  startupEnding = (sessionId: string, generation: string) => this.endings.get(sessionId, generation)
  retireStartup = (sessionId: string, generation: string) =>
    this.endings.retire(sessionId, generation)
  hasOwnedAcquisition = (sessionId: string): boolean => this.sessions.has(sessionId)

  closeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.close(input.sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.close(sessionId)

  acknowledgeSessionRelease = (sessionId: string): void => {
    const session = this.sessions.get(sessionId)
    if (session && !session.live) {
      this.sessions.delete(sessionId)
    }
  }

  async closeAll(): Promise<void> {
    this.endings.clear()
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  private async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    this.endings.retire(sessionId)
    await session.close()
    this.sessions.delete(sessionId)
    return true
  }
}

/** ZCode takes the prompt as one string; text blocks are joined (image prompts are unsupported). */
function zcodePromptText(body: AgentJournalMessageItem): string {
  return body.blocks
    .filter(
      (block): block is Extract<AgentJournalMessageItem['blocks'][number], { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.text)
    .join('\n\n')
}
