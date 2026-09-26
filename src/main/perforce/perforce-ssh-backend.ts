import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { isJsonRpcMethodNotFoundError } from '../providers/ssh-git-relay-errors'
import { localPerforceBackend, type PerforceBackend } from '../../shared/perforce/perforce-backend'
import { runWithPerforceSettings } from '../../shared/perforce/p4-settings-context'
import {
  DEFAULT_PERFORCE_SETTINGS,
  type PerforceSettings
} from '../../shared/perforce/perforce-settings'

let settingsSource: () => PerforceSettings = () => DEFAULT_PERFORCE_SETTINGS

/** Wired once at startup so every p4 call, local or over the relay, sees the current Settings > Perforce values. */
export function setPerforceSettingsSource(source: () => PerforceSettings): void {
  settingsSource = source
}

export function getPerforceSettings(): PerforceSettings {
  return settingsSource()
}

function scoped<Args extends unknown[], Result>(
  run: (...args: Args) => Result
): (...args: Args) => Result {
  return (...args) => runWithPerforceSettings(settingsSource(), () => run(...args))
}

function createLocalPerforceBackend(): PerforceBackend {
  const local = localPerforceBackend
  return {
    detect: scoped(local.detect),
    status: scoped(local.status),
    history: scoped(local.history),
    diff: scoped(local.diff),
    open: scoped(local.open),
    close: scoped(local.close),
    discard: scoped(local.discard),
    submit: scoped(local.submit),
    sync: scoped(local.sync),
    shelve: scoped(local.shelve),
    unshelve: scoped(local.unshelve),
    deleteShelf: scoped(local.deleteShelf),
    unshelveFiles: scoped(local.unshelveFiles),
    shelveAndRevertFiles: scoped(local.shelveAndRevertFiles),
    unshelveFrom: scoped(local.unshelveFrom),
    createChangelist: scoped(local.createChangelist),
    editDescription: scoped(local.editDescription),
    moveToChangelist: scoped(local.moveToChangelist),
    deleteChangelist: scoped(local.deleteChangelist),
    deleteChangelistWithFiles: scoped(local.deleteChangelistWithFiles),
    checkoutIfReadOnly: scoped(local.checkoutIfReadOnly),
    isReadOnlyFile: scoped(local.isReadOnlyFile),
    diffText: scoped(local.diffText),
    info: scoped(local.info)
  }
}

const settingsLocalBackend = createLocalPerforceBackend()

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
      return (await provider.requestRelay(`perforce.${method}`, {
        cwd,
        ...params,
        settings: settingsSource()
      })) as T
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
  return connectionId ? createSshPerforceBackend(connectionId) : settingsLocalBackend
}
