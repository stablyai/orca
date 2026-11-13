import type { CrashReportBreadcrumbData } from '../../../../shared/crash-reporting'
import type { InstalledBundleChange } from '../../../../shared/installed-bundle-change'
import { prepareRendererForAppRestart } from '../../../../shared/renderer-restart-preparation'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../../shared/renderer-shutdown-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT
} from '../../../../shared/updater-renderer-events'

// Bare reloads are vetoed by dirty tabs; restart preparation backs them up first.

export type LazyChunkRecoveryReloadOutcome =
  /** Hot-exit backup or the session checkpoint refused; unsaved work stays put. */
  | 'checkpoint-refused'
  /** Something still vetoed beforeunload after the restart latch was armed. */
  | 'unload-vetoed'
  /** No veto signal, but the document outlived the grace window. */
  | 'never-landed'
  /** The host rejected the reload request before navigation could begin. */
  | 'request-failed'
  /** The bundle on disk is a different build, so the app is relaunching instead of reloading. */
  | 'relaunch-requested'

/** Host facilities the recovery consults; defaults read the preload bridge and tolerate older hosts. */
export type LazyChunkRecoveryHost = {
  awaitCheckpoint: () => Promise<void>
  readInstalledBundleChange: () => Promise<InstalledBundleChange | null>
  relaunch: () => Promise<void>
}

// Paired-web hosts may veto navigation without emitting the Electron signal.
const RELOAD_SETTLE_GRACE_MS = 10_000

type RefusedNavigationWait = {
  outcome: Promise<'unload-vetoed' | 'never-landed'>
  cancel: () => void
}

/** Inline best-effort breadcrumbs keep low-level recovery free of renderer/webview imports for SSR and unit tests. */
export function recordLazyChunkBreadcrumb(name: string, data: CrashReportBreadcrumbData): void {
  try {
    const api = (window as Window & { api?: Window['api'] }).api
    api?.crashReports.recordBreadcrumb({ name, data })
  } catch {
    // Crash evidence is best-effort and must never mask the original failure.
  }
}

function preloadHost(): LazyChunkRecoveryHost {
  const api = typeof window === 'undefined' ? undefined : window.api?.app
  return {
    // Hosts without a preload bridge stage durably in-process; nothing to join.
    awaitCheckpoint: () => api?.awaitBeforeUnloadCheckpoint?.() ?? Promise.resolve(),
    readInstalledBundleChange: async () => (await api?.readInstalledBundleChange?.()) ?? null,
    relaunch: () =>
      api?.relaunch?.() ?? Promise.reject(new Error('This host cannot relaunch the app.'))
  }
}

function waitForRefusedNavigation(win: Window): RefusedNavigationWait {
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let onUnloadPrevented: () => void = () => undefined
  const cancel = (): void => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
    win.removeEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, onUnloadPrevented)
  }
  const outcome = new Promise<'unload-vetoed' | 'never-landed'>((resolve) => {
    const settle = (result: 'unload-vetoed' | 'never-landed'): void => {
      cancel()
      resolve(result)
    }
    onUnloadPrevented = () => settle('unload-vetoed')
    win.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, onUnloadPrevented)
    graceTimer = setTimeout(() => settle('never-landed'), RELOAD_SETTLE_GRACE_MS)
  })
  return { outcome, cancel }
}

/** Resolves only if the navigation is refused; a landed reload or relaunch destroys this document. */
export async function requestLazyChunkRecoveryReload(
  win: Window,
  host: Partial<LazyChunkRecoveryHost> = {}
): Promise<LazyChunkRecoveryReloadOutcome> {
  const { awaitCheckpoint, readInstalledBundleChange, relaunch } = { ...preloadHost(), ...host }

  // A replaced bundle (package manager, Homebrew, the manual-install card) cannot be reloaded into:
  // the new index.html would run a different build against this main process. Only a relaunch fits.
  let bundle: InstalledBundleChange | null = null
  try {
    bundle = await readInstalledBundleChange()
  } catch {
    // An unanswered probe keeps the reload path, which is what older hosts always did.
  }
  if (bundle?.changed) {
    recordLazyChunkBreadcrumb('lazy_chunk_relaunch', {
      runningVersion: bundle.runningVersion,
      installedVersion: bundle.installedVersion
    })
    try {
      // The preload relaunch runs restart preparation itself, so unsaved editors are backed up first.
      await relaunch()
      return 'relaunch-requested'
    } catch {
      return 'checkpoint-refused'
    }
  }

  try {
    await prepareRendererForAppRestart(win, {
      startedEventName: ORCA_APP_RESTART_STARTED_EVENT,
      abortedEventName: ORCA_APP_RESTART_ABORTED_EVENT,
      awaitCheckpoint
    })
  } catch {
    // Never reload over editor buffers that could not be backed up.
    return 'checkpoint-refused'
  }

  let cancelRefusalWait = (): void => undefined
  try {
    const refused = waitForRefusedNavigation(win)
    cancelRefusalWait = refused.cancel
    win.location.reload()
    return await refused.outcome
  } catch {
    return 'request-failed'
  } finally {
    cancelRefusalWait()
    // A surviving document must not retain the restart latch.
    win.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
  }
}
