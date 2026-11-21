import { localPerforceBackend, type PerforceBackend } from '../../shared/perforce/perforce-backend'
import { currentPerforceSettings } from '../../shared/perforce/p4-settings-context'
import { perforceSettingsForRemoteHost } from '../../shared/perforce/perforce-settings'

/** What an SSH relay receives: the request's settings, without the ones that only make sense on this computer. */
export function remotePerforceSettings(): ReturnType<typeof perforceSettingsForRemoteHost> {
  return perforceSettingsForRemoteHost(currentPerforceSettings())
}

// Remote (SSH) Perforce rode on the SSH relay that main removed; it needs re-homing onto orcad.
// Desktop/local Perforce is fully supported. A remote workspace refuses rather than running p4
// on the wrong host, and keeps the async backend contract so detection resolves to "unavailable".
const REMOTE_PERFORCE_DEFERRED_MESSAGE =
  'Remote Perforce is unavailable after the SSH relay change. Use a local Perforce workspace for now.'

function deferredRemotePerforceBackend(): PerforceBackend {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error(REMOTE_PERFORCE_DEFERRED_MESSAGE))
  return {
    detect: unavailable,
    status: unavailable,
    history: unavailable,
    diff: unavailable,
    open: unavailable,
    close: unavailable,
    edit: unavailable,
    discard: unavailable,
    submit: unavailable,
    sync: unavailable,
    shelve: unavailable,
    unshelve: unavailable,
    unshelveFrom: unavailable,
    deleteShelf: unavailable,
    shelveAndRevertFiles: unavailable,
    unshelveFiles: unavailable,
    createChangelist: unavailable,
    editDescription: unavailable,
    moveToChangelist: unavailable,
    deleteChangelist: unavailable,
    deleteChangelistWithFiles: unavailable,
    checkoutIfReadOnly: unavailable,
    isReadOnlyFile: unavailable,
    diffText: unavailable,
    info: unavailable
  }
}

/** Picks where p4 runs: this machine. Remote (SSH) Perforce is deferred pending orcad re-homing. */
export function resolvePerforceBackend(connectionId?: string | null): PerforceBackend {
  return connectionId ? deferredRemotePerforceBackend() : localPerforceBackend
}
