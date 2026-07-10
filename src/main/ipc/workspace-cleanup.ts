import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { listRegisteredPtys } from '../memory/pty-registry'
import { getSshPtyProvider } from './pty'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  type WorkspaceCleanupDismissArgs,
  type WorkspaceCleanupLocalProcessArgs,
  type WorkspaceCleanupLocalProcessResult,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanResult
} from '../../shared/workspace-cleanup'
import { scanWorkspaceCleanup } from './workspace-cleanup-scan'

export { scanWorkspaceCleanup }

type WorkspaceCleanupHandlerDeps = {
  runtime?: OrcaRuntimeService
  getLocalPtyProvider?: () => IPtyProvider
}

export function registerWorkspaceCleanupHandlers(
  store: Store,
  deps: WorkspaceCleanupHandlerDeps = {}
): void {
  ipcMain.removeHandler('workspaceCleanup:scan')
  ipcMain.removeHandler('workspaceCleanup:dismiss')
  ipcMain.removeHandler('workspaceCleanup:clearDismissals')
  ipcMain.removeHandler('workspaceCleanup:hasKillableLocalProcesses')

  ipcMain.handle(
    'workspaceCleanup:scan',
    (event, args?: WorkspaceCleanupScanArgs): Promise<WorkspaceCleanupScanResult> =>
      scanWorkspaceCleanup(store, args ?? {}, {
        onProgress: args?.scanId
          ? (progress) => event.sender.send('workspaceCleanup:scanProgress', progress)
          : undefined
      })
  )

  ipcMain.handle('workspaceCleanup:dismiss', (_event, args: WorkspaceCleanupDismissArgs) => {
    const current = store.getUI().workspaceCleanup?.dismissals ?? {}
    const next = { ...current }
    for (const dismissal of args.dismissals ?? []) {
      if (
        dismissal &&
        dismissal.classifierVersion === WORKSPACE_CLEANUP_CLASSIFIER_VERSION &&
        typeof dismissal.worktreeId === 'string' &&
        typeof dismissal.fingerprint === 'string'
      ) {
        next[dismissal.worktreeId] = dismissal
      }
    }
    store.updateUI({ workspaceCleanup: { dismissals: next } })
  })

  ipcMain.handle('workspaceCleanup:clearDismissals', () => {
    store.updateUI({ workspaceCleanup: { dismissals: {} } })
  })

  ipcMain.handle(
    'workspaceCleanup:hasKillableLocalProcesses',
    async (
      _event,
      args: WorkspaceCleanupLocalProcessArgs
    ): Promise<WorkspaceCleanupLocalProcessResult> => ({
      hasKillableProcesses: await hasKillableProcesses(args, deps)
    })
  )
}

async function hasKillableProcesses(
  args: WorkspaceCleanupLocalProcessArgs,
  deps: WorkspaceCleanupHandlerDeps
): Promise<boolean | null> {
  const { worktreeId } = args
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
    return false
  }

  let livenessUnknown = false
  if (deps.runtime) {
    try {
      if (await deps.runtime.hasTerminalsForWorktree(worktreeId)) {
        return true
      }
    } catch {
      livenessUnknown = true
    }
  }

  if (args.connectionId) {
    return hasKillableSshProcesses(args.connectionId, args.worktreePath ?? '', livenessUnknown)
  }

  const registryPtyIds = new Set(
    listRegisteredPtys()
      .filter((entry) => entry.worktreeId === worktreeId)
      .map((entry) => entry.ptyId)
  )

  const provider = deps.getLocalPtyProvider?.()
  if (!provider) {
    return registryPtyIds.size > 0 ? true : null
  }

  try {
    const prefix = `${worktreeId}@@`
    const sessions = await provider.listProcesses()
    if (
      sessions.some((session) => session.id.startsWith(prefix) || registryPtyIds.has(session.id))
    ) {
      return true
    }
    return livenessUnknown ? null : false
  } catch {
    return registryPtyIds.size > 0 ? true : null
  }
}

async function hasKillableSshProcesses(
  connectionId: string,
  worktreePath: string,
  livenessUnknown: boolean
): Promise<boolean | null> {
  const provider = getSshPtyProvider(connectionId)
  if (!provider) {
    return null
  }

  try {
    const normalizedWorktreePath = normalizeRemotePath(worktreePath)
    const sessions = await provider.listProcesses()
    if (
      sessions.some((session) => {
        if (session.id.startsWith(`${worktreePath}@@`)) {
          return true
        }
        return (
          normalizedWorktreePath.length > 0 &&
          isPathWithin(normalizeRemotePath(session.cwd), normalizedWorktreePath)
        )
      })
    ) {
      return true
    }
    return livenessUnknown ? null : false
  } catch {
    return null
  }
}

function normalizeRemotePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isPathWithin(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`)
}
