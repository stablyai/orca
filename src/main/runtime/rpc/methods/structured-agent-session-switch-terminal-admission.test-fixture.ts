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
  const provider = {
    supportsAgentSessionClaims: async () => opts.supportsClaims ?? true,
    providesAgentSessionOwnerListings: () => listsOwners,
    listProcesses: async (args?: { ptyIds?: string[] }) => {
      if (listingFails) {
        throw new Error('listing failed')
      }
      return [...sessions.values()].filter(
        (session) => !args?.ptyIds?.length || args.ptyIds.includes(session.id)
      )
    }
  }
  // A switch and main's claimed create reach only these three provider members.
  const ptyProvider = provider as unknown as IPtyProvider
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
      spawn: async ({ generation }) => {
        const owner = {
          claim: ensure.claim,
          generation,
          phase: 'live' as const,
          ptyId: `switch-pty-${++started}`,
          surface: ensure.surface
        }
        ptyIncarnationById.set(owner.ptyId, list(owner))
        return listsOwners
          ? { ptyId: owner.ptyId, owner, disposition: 'created' as const }
          : { ptyId: owner.ptyId }
      },
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
    /** A claimed create for `claim` still starting: its reservation stands until disposal. */
    pendingCreate: (claim: AgentSessionExecutionClaim) => {
      void agentSessionOwners
        .ensure({
          claim,
          surface: ownerOf(claim, 'pending-pty').surface,
          spawn: () => new Promise((_resolve, reject) => pendingSpawns.push(reject))
        })
        .catch(() => {})
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
