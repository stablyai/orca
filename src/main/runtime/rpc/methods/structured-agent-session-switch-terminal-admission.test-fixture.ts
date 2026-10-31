import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type {
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding
} from '../../../../shared/agent-session-host-authority'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import {
  agentSessionOwners,
  reconcileAgentSessionOwnerListings
} from '../../../ipc/pty/pane/agent-session-owners'
import { prepareAgentSessionOwner } from '../../../ipc/pty/pane/agent-session-owner-preparation'
import { isRegisteredAgentSessionOwnerLive } from '../../../ipc/pty/provider/liveness'
import { ptyIncarnationById, ptyOwnership } from '../../../ipc/pty/provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../../ipc/pty/provider/registry'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { HOST_TEST_SESSION as id } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setupMainOwnedWorkspace, WORKTREE_ID } from '../../main-owned-workspace-runtime-fixture'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'

export function ownerOf(
  claim: AgentSessionExecutionClaim,
  ptyId: string
): AgentSessionOwnerBinding {
  return {
    claim,
    generation: `${ptyId}-generation`,
    phase: 'live',
    ptyId,
    surface: {
      worktreeId: 'other-worktree',
      tabId: `${ptyId}-tab`,
      leafId: `${ptyId}-leaf`,
      terminalHandle: `${ptyId}-handle`
    }
  }
}

export type ExecutionOwnerRig = ReturnType<typeof executionOwnerRig>

/**
 * A chat-to-terminal switch over main's real claim registry and ownership preparation. One
 * execution owner stands in for the daemon (it lists each terminal's claimed owner) or for the
 * in-process provider (it lists none). The controller's spawn is main's claimed create as
 * spawn-execute runs it: listings reconciled, then the registry's `ensure` with its liveness proof.
 */
export function executionOwnerRig(
  chat: { host: StructuredAgentSessionHost; root: string; nativeId: string },
  opts: {
    listsOwners?: boolean
    supportsClaims?: boolean
    /** Runs with the switch's own claim, before the production preparation reads anything. */
    seed?: (claim: AgentSessionExecutionClaim) => void
  } = {}
) {
  const listsOwners = opts.listsOwners ?? true
  const sessions = new Map<string, PtyProcessInfo>()
  const rows: AgentStatusIpcPayload[] = []
  const exited = new Set<string>()
  const pendingSpawns: ((error: Error) => void)[] = []
  let started = 0
  let listingFails = false
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected PTY effect')
  }
  // A switch and main's claimed create reach only the claim probe, owner listing and inventory.
  const ptyProvider: IPtyProvider = {
    supportsAgentSessionClaims: async () => opts.supportsClaims ?? true,
    providesAgentSessionOwnerListings: () => listsOwners,
    listProcesses: async (args) => {
      if (listingFails) {
        throw new Error('listing failed')
      }
      return [...sessions.values()].filter(
        (session) => !args?.ptyIds?.length || args.ptyIds.includes(session.id)
      )
    },
    spawn: unused,
    attach: unused,
    write: () => {},
    writeWithSettlement: unused,
    resize: () => {},
    shutdown: unused,
    sendSignal: unused,
    getCwd: unused,
    getInitialCwd: unused,
    clearBuffer: unused,
    resetInputModes: unused,
    acknowledgeDataEvent: () => {},
    hasChildProcesses: async () => false,
    getForegroundProcess: async () => null,
    serialize: unused,
    revive: unused,
    getDefaultShell: unused,
    getProfiles: unused,
    onData: () => () => {},
    onReplay: () => () => {},
    onExit: () => () => {}
  }
  const previousProvider = getLocalPtyProvider()
  setLocalPtyProvider(ptyProvider)
  const list = (owner?: AgentSessionOwnerBinding, ptyId = owner?.ptyId ?? ''): string => {
    const incarnationId = randomUUID()
    sessions.set(ptyId, {
      id: ptyId,
      cwd: chat.root,
      title: '',
      incarnationId,
      ...(owner && listsOwners ? { agentSessionOwners: [owner] } : {})
    })
    return incarnationId
  }
  /** One CLI started for a claimed create: the execution owner lists it from then on. */
  const start = (owner: Pick<AgentSessionOwnerBinding, 'claim' | 'surface' | 'generation'>) => {
    const ptyId = `switch-pty-${++started}`
    const live = { ...owner, phase: 'live' as const, ptyId }
    ptyIncarnationById.set(ptyId, list(live))
    return listsOwners ? { ptyId, owner: live, disposition: 'created' as const } : { ptyId }
  }
  const spawn: NonNullable<RuntimePtyController['spawn']> = async (args) => {
    const ensure = args.agentSessionEnsure
    if (!ensure) {
      const ptyId = `switch-pty-${++started}`
      return { id: ptyId, incarnationId: list(undefined, ptyId) }
    }
    await reconcileAgentSessionOwnerListings()
    const ensured = await agentSessionOwners.ensure({
      claim: ensure.claim,
      surface: ensure.surface,
      spawn: async ({ generation }) => start({ ...ensure, generation }),
      isLive: isRegisteredAgentSessionOwnerLive
    })
    const ptyId = ensured.owner.ptyId
    return {
      id: ptyId,
      incarnationId: sessions.get(ptyId)?.incarnationId,
      agentSessionEnsure: ensured,
      ...(ensured.disposition === 'adopted' ? { isReattach: true } : {})
    }
  }
  const { runtime } = setupMainOwnedWorkspace({
    runtimeDeps: {
      getLocalProvider: () => ptyProvider,
      readHookCliWriterObservation: (row) => ({
        current: () => true,
        presence: async () => (exited.has(row.paneKey) ? 'exited' : 'live'),
        topology: 'pane-owned'
      })
    }
  })
  vi.spyOn(runtime, 'getAgentProviderSessionRows').mockImplementation(() => rows)
  vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: chat.root,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const install = (): void =>
    runtime.setPtyController({
      spawn,
      prepareAgentSessionOwner: async (claim) => {
        opts.seed?.(claim)
        return await prepareAgentSessionOwner(claim)
      },
      write: () => true,
      kill: () => true,
      stopAndWait: async () => true,
      getForegroundProcess: async () => null
    })
  install()
  const spawned: RuntimeTerminalCreate[] = []
  const spawnSwitchTerminal = runtime.spawnSwitchTerminal.bind(runtime)
  vi.spyOn(runtime, 'spawnSwitchTerminal').mockImplementation(async (...args) => {
    const terminal = await spawnSwitchTerminal(...args)
    spawned.push(terminal)
    return terminal
  })
  return {
    spawned,
    place: vi.spyOn(runtime, 'placeSwitchTerminal'),
    stop: vi.spyOn(chat.host, 'stopForSwitch'),
    started: () => started,
    owners: () => agentSessionOwners.list(),
    run: (invocationId: string) =>
      executeStructuredSessionSwitch(
        { sessionId: id, execution: { invocationId } },
        { runtime },
        'terminal'
      ),
    list: (owner: AgentSessionOwnerBinding): void => {
      list(owner)
    },
    /** A status-store row on the chat's conversation, live unless `exited`. */
    row: (paneKey: string, worktreeId = WORKTREE_ID, presence: 'live' | 'exited' = 'live') => {
      rows.push({
        paneKey,
        worktreeId,
        connectionId: null,
        agentType: 'codex',
        receivedAt: 1,
        stateStartedAt: 1,
        state: 'done',
        prompt: '',
        providerSession: { key: 'session_id', id: chat.nativeId }
      })
      if (presence === 'exited') {
        exited.add(paneKey)
      }
    },
    exit: (ptyId: string) => sessions.delete(ptyId),
    failListing: () => {
      listingFails = true
    },
    /** A claimed create for `claim` in this worktree still starting, on the pane it returns: it
     *  starts its CLI on the next turn when it `resolves`, else it stands until disposal. */
    pendingCreate: (claim: AgentSessionExecutionClaim, resolves = false) => {
      const surface = {
        worktreeId: WORKTREE_ID,
        tabId: randomUUID(),
        leafId: randomUUID(),
        terminalHandle: 'pending-handle'
      }
      void agentSessionOwners
        .ensure({
          claim,
          surface,
          spawn: ({ generation }) =>
            new Promise((resolve, reject) => {
              if (resolves) {
                setTimeout(() => resolve(start({ claim, surface, generation })), 0)
              } else {
                pendingSpawns.push(reject)
              }
            })
        })
        .catch(() => {})
      return surface
    },
    /** Main restarts while the execution owner keeps its terminals: main's claim state is empty. */
    relaunch: () => {
      agentSessionOwners.reconcileAuthoritative([])
      for (const ptyId of sessions.keys()) {
        ptyIncarnationById.delete(ptyId)
        ptyOwnership.delete(ptyId)
      }
      install()
    },
    dispose: async () => {
      for (const reject of pendingSpawns) {
        reject(new Error('test over'))
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      agentSessionOwners.reconcileAuthoritative([])
      for (const ptyId of sessions.keys()) {
        ptyIncarnationById.delete(ptyId)
        ptyOwnership.delete(ptyId)
      }
      setLocalPtyProvider(previousProvider)
    }
  }
}
