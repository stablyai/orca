import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import type {
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../../shared/agent-session-host-authority'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { agentProviderSessionIdentity } from '../../../shared/agent-session-resume'
import {
  recoveryBindingKeyString,
  type RecoveryBindingKey
} from '../../../shared/cross-machine-recovery-binding-key'
import type { RecoveryProvenance } from '../../../shared/cross-machine-recovery-descriptor'
import {
  applyCrossMachineRecoveryOp,
  CROSS_MACHINE_RECOVERY_APPLY_CHANNEL,
  CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL,
  type CrossMachineRecoveryApplyOp,
  type CrossMachineRecoveryApplyOutcome,
  type CrossMachineRecoveryApplyReply
} from '../../../shared/cross-machine-recovery-session-ops'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { cloneWorkspaceSessionState } from '../../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../persistence/restoring-sessions/workspace-session-write-rollback'
import { getRuntimeDesktopSurface } from '../runtime-desktop-surface'
import type { RuntimeStore } from '../runtime-store-contract'

const RENDERER_APPLY_TIMEOUT_MS = 15_000

/** The narrow runtime surface cross-machine import and resume need. */
export type CrossMachineRecoveryHost = {
  now(): number
  mintId(): string
  listLocalRepos(): { id: string; path: string }[]
  addRepo(repoPath: string): Promise<{ id: string }>
  invalidateWorktreeCatalog(repoId: string): void
  resolveWorktree(selector: string): Promise<{ id: string; repoId: string; instanceId?: string }>
  getLocalSession(): WorkspaceSessionState
  getWorktreeMeta(worktreeId: string): WorktreeMeta | undefined
  setRecoveryProvenance(worktreeId: string, provenance: RecoveryProvenance): Promise<void>
  /** Applies through the renderer when one is attached, else through the runtime's durable writer. */
  applyOp(op: CrossMachineRecoveryApplyOp): Promise<CrossMachineRecoveryApplyOutcome>
  ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest
  ): Promise<RuntimeEnsureAgentSessionResult>
  /** Only local execution counts: an SSH pane showing the session runs it on another machine. */
  isProviderSessionLive(binding: RecoveryBindingKey): boolean
  activateWorktree(worktreeId: string): Promise<void>
}

export type CrossMachineRecoveryHostDeps = Omit<
  CrossMachineRecoveryHost,
  | 'now'
  | 'mintId'
  | 'getLocalSession'
  | 'getWorktreeMeta'
  | 'setRecoveryProvenance'
  | 'applyOp'
  | 'isProviderSessionLive'
> & {
  store: RuntimeStore | null
  getAuthoritativeWindow(): BrowserWindow | null
  getAgentStatusSnapshot(): readonly AgentStatusIpcPayload[]
}

function applyThroughRenderer(
  win: BrowserWindow,
  op: CrossMachineRecoveryApplyOp
): Promise<CrossMachineRecoveryApplyOutcome> {
  const surface = getRuntimeDesktopSurface()
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const handler = (event: IpcMainEvent, reply: CrossMachineRecoveryApplyReply): void => {
      if (event.sender !== win.webContents || reply.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      surface.removeIpcListener(CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL, handler)
      if ('error' in reply) {
        reject(new Error(reply.error))
      } else {
        resolve(reply.outcome)
      }
    }
    const timer = setTimeout(() => {
      surface.removeIpcListener(CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL, handler)
      reject(new Error('runtime_unavailable'))
    }, RENDERER_APPLY_TIMEOUT_MS)
    surface.onIpc(CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL, handler)
    win.webContents.send(CROSS_MACHINE_RECOVERY_APPLY_CHANNEL, { requestId, op })
  })
}

async function applyThroughRuntimeWriter(
  store: RuntimeStore,
  op: CrossMachineRecoveryApplyOp
): Promise<CrossMachineRecoveryApplyOutcome> {
  // Why bind: these are Store methods; the durable writer reads its own private fields.
  const getWorkspaceSession = store.getWorkspaceSession?.bind(store)
  const setWorkspaceSession = store.setWorkspaceSession?.bind(store)
  const runDurableMutation = store.runDurableMutation?.bind(store)
  if (!getWorkspaceSession || !setWorkspaceSession || !runDurableMutation) {
    throw new Error('workspace_session_unavailable')
  }
  return await runDurableMutation<CrossMachineRecoveryApplyOutcome>(() => {
    const before = cloneWorkspaceSessionState(getWorkspaceSession(LOCAL_EXECUTION_HOST_ID))
    const { session, outcome } = applyCrossMachineRecoveryOp(before, op)
    if (!outcome.ok) {
      return { value: outcome, persist: false }
    }
    setWorkspaceSession(session, LOCAL_EXECUTION_HOST_ID)
    const staged = cloneWorkspaceSessionState(getWorkspaceSession(LOCAL_EXECUTION_HOST_ID))
    return {
      value: outcome,
      rollback: () => {
        const current = getWorkspaceSession(LOCAL_EXECUTION_HOST_ID)
        const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(before, staged, current)
        if (rolledBack !== current) {
          setWorkspaceSession(rolledBack, LOCAL_EXECUTION_HOST_ID)
        }
      }
    }
  })
}

export function createCrossMachineRecoveryHost(
  deps: CrossMachineRecoveryHostDeps
): CrossMachineRecoveryHost {
  const requireStore = (): RuntimeStore => {
    if (!deps.store) {
      throw new Error('runtime_unavailable')
    }
    return deps.store
  }
  return {
    now: () => Date.now(),
    mintId: () => randomUUID(),
    listLocalRepos: deps.listLocalRepos,
    addRepo: deps.addRepo,
    invalidateWorktreeCatalog: deps.invalidateWorktreeCatalog,
    resolveWorktree: deps.resolveWorktree,
    ensureAgentSession: deps.ensureAgentSession,
    activateWorktree: deps.activateWorktree,
    getLocalSession: () => {
      const session = requireStore().getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
      if (!session) {
        throw new Error('workspace_session_unavailable')
      }
      return session
    },
    getWorktreeMeta: (worktreeId) => requireStore().getWorktreeMeta(worktreeId),
    setRecoveryProvenance: async (worktreeId, recoveryProvenance) => {
      const store = requireStore()
      const runDurableMutation = store.runDurableMutation?.bind(store)
      if (!runDurableMutation) {
        throw new Error('workspace_session_unavailable')
      }
      // Why durable before replying: a retried import finds its importKey only through this row.
      await runDurableMutation(() => {
        const previous = store.getWorktreeMeta(worktreeId)?.recoveryProvenance
        store.setWorktreeMeta(worktreeId, { recoveryProvenance })
        return {
          value: undefined,
          rollback: () => {
            store.setWorktreeMeta(worktreeId, { recoveryProvenance: previous })
          }
        }
      })
    },
    applyOp: async (op) => {
      const win = deps.getAuthoritativeWindow()
      return win
        ? await applyThroughRenderer(win, op)
        : await applyThroughRuntimeWriter(requireStore(), op)
    },
    isProviderSessionLive: (binding) => {
      const wanted = recoveryBindingKeyString(binding)
      return deps
        .getAgentStatusSnapshot()
        .some(
          (row) =>
            row.connectionId === null &&
            row.agentType === binding.agent &&
            row.providerSession !== undefined &&
            agentProviderSessionIdentity(binding.agent, row.providerSession) === wanted
        )
    }
  }
}
