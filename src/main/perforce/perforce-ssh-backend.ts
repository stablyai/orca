import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { isJsonRpcMethodNotFoundError } from '../providers/ssh-git-relay-errors'
import { localPerforceBackend, type PerforceBackend } from '../../shared/perforce/perforce-backend'
import { currentPerforceSettings } from '../../shared/perforce/p4-settings-context'
import {
  perforceRequestTimeoutMs,
  perforceSettingsForRemoteHost
} from '../../shared/perforce/perforce-settings'

/** What an SSH relay receives: the request's settings, without the ones that only make sense on this computer. */
export function remotePerforceSettings(): ReturnType<typeof perforceSettingsForRemoteHost> {
  return perforceSettingsForRemoteHost(currentPerforceSettings())
}

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
      return (await provider.requestRelay(
        `perforce.${method}`,
        { cwd, ...params, settings: remotePerforceSettings() },
        { timeoutMs: perforceRequestTimeoutMs(currentPerforceSettings(), method) }
      )) as T
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
    edit: (cwd, filePaths) => call<Result>('edit', cwd, { filePaths }),
    discard: (cwd, entries) => call<Result>('discard', cwd, { entries }),
    submit: (cwd, changelist, message) => call<Result>('submit', cwd, { changelist, message }),
    sync: (cwd) => call<Result>('sync', cwd),
    shelve: (cwd, changelist) => call<Result>('shelve', cwd, { changelist }),
    unshelve: (cwd, changelist) => call<Result>('unshelve', cwd, { changelist }),
    unshelveFrom: (cwd, sourceChangelist, changelist) =>
      call<Result>('unshelveFrom', cwd, { sourceChangelist, changelist }),
    deleteShelf: (cwd, changelist) => call<Result>('deleteShelf', cwd, { changelist }),
    shelveAndRevertFiles: (cwd, changelist, filePaths) =>
      call<Result>('shelveAndRevertFiles', cwd, { changelist, filePaths }),
    unshelveFiles: (cwd, changelist, depotPaths) =>
      call<Result>('unshelveFiles', cwd, { changelist, depotPaths }),
    createChangelist: (cwd, description, filePaths) =>
      call('createChangelist', cwd, { description, filePaths }),
    editDescription: (cwd, changelist, description) =>
      call<Result>('editDescription', cwd, { changelist, description }),
    moveToChangelist: (cwd, filePaths, changelist) =>
      call<Result>('moveToChangelist', cwd, { filePaths, changelist }),
    deleteChangelist: (cwd, changelist) => call<Result>('deleteChangelist', cwd, { changelist }),
    deleteChangelistWithFiles: (cwd, changelist) =>
      call<Result>('deleteChangelistWithFiles', cwd, { changelist }),
    checkoutIfReadOnly: (cwd, filePath) => call<void>('checkoutIfReadOnly', cwd, { filePath }),
    isReadOnlyFile: (cwd, filePath) => call<boolean>('isReadOnlyFile', cwd, { filePath }),
    diffText: (cwd, filePaths) => call<string>('diffText', cwd, { filePaths }),
    info: (cwd) => call<Awaited<ReturnType<PerforceBackend['info']>>>('info', cwd)
  }
}

/** Picks where p4 runs: the SSH host when the workspace is remote, this machine otherwise. */
export function resolvePerforceBackend(connectionId?: string | null): PerforceBackend {
  return connectionId ? createSshPerforceBackend(connectionId) : localPerforceBackend
}
