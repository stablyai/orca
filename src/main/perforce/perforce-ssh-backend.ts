import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { isJsonRpcMethodNotFoundError } from '../providers/ssh-git-relay-errors'
import { localPerforceBackend, type PerforceBackend } from '../../shared/perforce/perforce-backend'

const RELAY_TOO_OLD_MESSAGE =
  'The Orca relay on this SSH host does not support Perforce yet. Reconnect the SSH target to update it.'

function createSshPerforceBackend(connectionId: string): PerforceBackend {
  // SAFETY: the relay's perforce.* handlers return exactly the PerforceBackend result shapes.
  const call = async <T>(method: string, cwd: string, params: Record<string, unknown> = {}) => {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
      return (await provider.requestRelay(`perforce.${method}`, { cwd, ...params })) as T
    } catch (error) {
      throw isJsonRpcMethodNotFoundError(error) ? new Error(RELAY_TOO_OLD_MESSAGE) : error
    }
  }
  type Result = Awaited<ReturnType<PerforceBackend['open']>>
  return {
    detect: (cwd) => call('detect', cwd),
    status: (cwd) => call('status', cwd),
    history: (cwd, limit) => call('history', cwd, { limit }),
    diff: (cwd, filePath) => call('diff', cwd, { filePath }),
    open: (cwd, filePaths) => call<Result>('open', cwd, { filePaths }),
    close: (cwd, filePaths) => call<Result>('close', cwd, { filePaths }),
    discard: (cwd, entries) => call<Result>('discard', cwd, { entries }),
    submit: (cwd, changelist, message) => call<Result>('submit', cwd, { changelist, message }),
    sync: (cwd) => call<Result>('sync', cwd),
    shelve: (cwd, changelist) => call<Result>('shelve', cwd, { changelist }),
    unshelve: (cwd, changelist) => call<Result>('unshelve', cwd, { changelist }),
    deleteShelf: (cwd, changelist) => call<Result>('deleteShelf', cwd, { changelist }),
    createChangelist: (cwd, description, filePaths) =>
      call('createChangelist', cwd, { description, filePaths }),
    editDescription: (cwd, changelist, description) =>
      call<Result>('editDescription', cwd, { changelist, description }),
    moveToChangelist: (cwd, filePaths, changelist) =>
      call<Result>('moveToChangelist', cwd, { filePaths, changelist }),
    deleteChangelist: (cwd, changelist) => call<Result>('deleteChangelist', cwd, { changelist }),
    checkoutIfReadOnly: (cwd, filePath) => call<void>('checkoutIfReadOnly', cwd, { filePath })
  }
}

/** Picks where p4 runs: the SSH host when the workspace is remote, this machine otherwise. */
export function resolvePerforceBackend(connectionId?: string | null): PerforceBackend {
  return connectionId ? createSshPerforceBackend(connectionId) : localPerforceBackend
}
