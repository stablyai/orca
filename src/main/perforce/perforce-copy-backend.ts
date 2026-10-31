import { removeHostTree } from '../host-tree-removal'
import { readProcessesHoldingFolder } from '../windows/windows-folder-holders'
import {
  createLocalWorkspaceCopyBackend,
  type WorkspaceCopyBackend
} from '../../shared/perforce/workspace-copy/workspace-copy-backend'
import { createWorkspaceCopyHost } from '../../shared/perforce/workspace-copy/workspace-copy-host'
import { endWorkspaceCopyHolder } from './perforce-copy-holder-termination'
import { listCopyHostProcesses } from './perforce-copy-host-processes'

// Remote (SSH) Perforce copies rode on the SSH relay that main removed; they need re-homing onto
// orcad. Local copies are fully supported; a remote workspace refuses rather than copying elsewhere.
const REMOTE_COPY_DEFERRED_MESSAGE =
  'Remote Perforce workspace copies are unavailable after the SSH relay change. Use a local workspace for now.'

let localBackend: WorkspaceCopyBackend | null = null

function createLocalBackend(): WorkspaceCopyBackend {
  return createLocalWorkspaceCopyBackend(
    createWorkspaceCopyHost({
      removeTree: removeHostTree,
      listProcesses: process.platform === 'win32' ? listCopyHostProcesses : undefined,
      listFolderHolders: process.platform === 'win32' ? readProcessesHoldingFolder : undefined,
      endProcess: process.platform === 'win32' ? endWorkspaceCopyHolder : undefined
    })
  )
}

function deferredRemoteBackend(): WorkspaceCopyBackend {
  const unavailable = (): Promise<never> => Promise.reject(new Error(REMOTE_COPY_DEFERRED_MESSAGE))
  return {
    readiness: unavailable,
    list: unavailable,
    create: unavailable,
    previewRemoval: unavailable,
    remove: unavailable,
    streams: unavailable,
    previewCopyUp: unavailable,
    copyUp: unavailable
  }
}

/** Picks where copies are made: this machine. Remote (SSH) copies are deferred pending orcad re-homing. */
export function resolveWorkspaceCopyBackend(connectionId?: string | null): WorkspaceCopyBackend {
  if (connectionId) {
    return deferredRemoteBackend()
  }
  localBackend ??= createLocalBackend()
  return localBackend
}
