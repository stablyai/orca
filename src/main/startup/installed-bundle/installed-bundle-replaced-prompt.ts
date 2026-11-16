import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { InstalledBundleChange } from '../../../shared/installed-bundle-change'
import { translateMain } from '../../i18n/main-i18n'

export type InstalledBundleReplacedPromptDeps = {
  readChange: () => Promise<InstalledBundleChange>
  isQuitting: () => boolean
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  restart: () => void
  recordBreadcrumb: (change: InstalledBundleChange) => void
  now?: () => number
}

// Focus is the moment before the user clicks something that may lazy-load; stat once per return, not per event burst.
const RECHECK_MIN_INTERVAL_MS = 30_000

/**
 * A native dialog, because the renderer's own update card is a lazy chunk and is exactly what
 * fails to load once the archive underneath it has been replaced (#13171).
 */
export function createInstalledBundleReplacedWatch(deps: InstalledBundleReplacedPromptDeps): {
  onAppFocused: () => void
} {
  const now = deps.now ?? Date.now
  let lastCheckedAt = Number.NEGATIVE_INFINITY
  let prompted = false
  let checking = false
  const check = async (): Promise<void> => {
    const change = await deps.readChange()
    if (!change.changed || prompted) {
      return
    }
    // Later is final for this run; the lazy-chunk path still relaunches if a load fails.
    prompted = true
    deps.recordBreadcrumb(change)
    await presentInstalledBundleReplacedPrompt(change, deps)
  }
  return {
    onAppFocused: () => {
      if (
        prompted ||
        checking ||
        deps.isQuitting() ||
        now() - lastCheckedAt < RECHECK_MIN_INTERVAL_MS
      ) {
        return
      }
      lastCheckedAt = now()
      checking = true
      void check().finally(() => {
        checking = false
      })
    }
  }
}

async function presentInstalledBundleReplacedPrompt(
  change: InstalledBundleChange,
  deps: Pick<InstalledBundleReplacedPromptDeps, 'isQuitting' | 'showMessageBox' | 'restart'>
): Promise<void> {
  const detail = change.installedVersion
    ? translateMain(
        'installedBundleReplaced.detailWithVersions',
        'Version {{installedVersion}} is now installed, but this window is still running {{runningVersion}}. Until Orca restarts, some panels and files may fail to open.',
        { installedVersion: change.installedVersion, runningVersion: change.runningVersion ?? '' }
      )
    : translateMain(
        'installedBundleReplaced.detail',
        'The installed files no longer match the build this window is running. Until Orca restarts, some panels and files may fail to open.'
      )
  const { response } = await deps.showMessageBox({
    type: 'info',
    buttons: [
      translateMain('installedBundleReplaced.restart', 'Restart Orca'),
      translateMain('installedBundleReplaced.later', 'Later')
    ],
    defaultId: 0,
    cancelId: 1,
    title: translateMain('installedBundleReplaced.title', 'Orca was updated on disk'),
    message: translateMain(
      'installedBundleReplaced.message',
      'Orca was updated on this computer while it was running.'
    ),
    detail
  })
  if (response === 0 && !deps.isQuitting()) {
    deps.restart()
  }
}
