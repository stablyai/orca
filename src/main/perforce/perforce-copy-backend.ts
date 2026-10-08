import { removeHostTree } from '../host-tree-removal'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { isJsonRpcMethodNotFoundError } from '../providers/ssh-git-relay-errors'
import { SSH_MUX_REQUEST_TIMEOUT_CODE } from '../ssh/ssh-channel-multiplexer'
import { readProcessesHoldingFolder } from '../windows/windows-folder-holders'
import {
  createLocalWorkspaceCopyBackend,
  type WorkspaceCopyBackend
} from '../../shared/perforce/workspace-copy/workspace-copy-backend'
import { createWorkspaceCopyHost } from '../../shared/perforce/workspace-copy/workspace-copy-host'
import { PERFORCE_COPY_REQUEST_TIMEOUT_MS } from '../../shared/perforce/workspace-copy/workspace-copy-operations'
import { endWorkspaceCopyHolder } from './perforce-copy-holder-termination'
import { listCopyHostProcesses } from './perforce-copy-host-processes'
import { remotePerforceSettings } from './perforce-ssh-backend'

const RELAY_TOO_OLD_MESSAGE =
  'The Orca relay on this SSH host does not support Perforce workspace copies yet. Reconnect the SSH target to update it.'
const RELAY_TIMEOUT_MESSAGE =
  'The SSH host did not answer in time. The copy operation may still be running there; refresh the list to see its state.'

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

function createSshBackend(connectionId: string): WorkspaceCopyBackend {
  const call = async <T>(method: string, cwd: string, params: Record<string, unknown>) => {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay's perforce copy handlers return exactly the WorkspaceCopyBackend result shapes.
      return (await provider.requestRelay(
        `perforce.${method}`,
        { cwd, ...params, settings: remotePerforceSettings() },
        { timeoutMs: PERFORCE_COPY_REQUEST_TIMEOUT_MS }
      )) as T
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        throw new Error(RELAY_TOO_OLD_MESSAGE)
      }
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === SSH_MUX_REQUEST_TIMEOUT_CODE
      ) {
        throw new Error(RELAY_TIMEOUT_MESSAGE)
      }
      throw error
    }
  }
  return {
    readiness: (cwd, minFreeBytes) => call('copyReadiness', cwd, { minFreeBytes }),
    list: (cwd) => call('listCopies', cwd, {}),
    // Progress is not streamed over the relay; the pending row stays indeterminate.
    create: (cwd, options) => call('createCopy', cwd, { options }),
    previewRemoval: (cwd, name) => call('previewCopyRemoval', cwd, { name }),
    remove: (cwd, name, options) => call('removeCopy', cwd, { name, options }),
    streams: (cwd) => call('listCopyStreams', cwd, {})
  }
}

/** Picks where copies are made: the SSH host when the workspace is remote, this machine otherwise. */
export function resolveWorkspaceCopyBackend(connectionId?: string | null): WorkspaceCopyBackend {
  if (connectionId) {
    return createSshBackend(connectionId)
  }
  localBackend ??= createLocalBackend()
  return localBackend
}
