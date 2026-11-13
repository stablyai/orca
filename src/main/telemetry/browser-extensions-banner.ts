import { createHash } from 'node:crypto'
import type { Store } from '../persistence/loading-store/store'
import {
  browserExtensionsBannerAssignmentSchema,
  type BrowserExtensionsBanner,
  type BrowserExtensionsBannerAssignment,
  type BrowserExtensionsBannerAssignmentReply
} from '../../shared/browser/extensions/browser-extensions-banner'
import { getBrowserExtensionInstallStore } from '../browser/extensions/installation/browser-extension-install-store'
import { isTelemetryEnabled, track } from './client'

const BANNERS = [
  'none',
  'none',
  'plain_bring',
  'colored_bring',
  'plain_everyday',
  'colored_everyday'
] as const satisfies readonly BrowserExtensionsBanner[]

let storeRef: Store | null = null
let inFlight: Promise<BrowserExtensionsBannerAssignmentReply> | null = null
let heldUntilNextLaunch = false
let usedThisSession = false

export function initBrowserExtensionsBanner(store: Store): void {
  storeRef = store
  inFlight = null
  heldUntilNextLaunch = false
  usedThisSession = false
}

export function browserExtensionsBannerForInstall(installId: string): BrowserExtensionsBanner {
  const bucket =
    createHash('sha256').update(`browser-extensions-banner:${installId}`).digest().readUInt32BE(0) %
    BANNERS.length
  return BANNERS[bucket]
}

/** Windows asking at once share one run, so an install gets one saved record and one event. */
export function assignBrowserExtensionsBanner(): Promise<BrowserExtensionsBannerAssignmentReply> {
  if (heldUntilNextLaunch) {
    return Promise.resolve({ status: 'deferred' })
  }
  inFlight ??= assign().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function assign(): Promise<BrowserExtensionsBannerAssignmentReply> {
  const store = storeRef
  if (!store) {
    return { status: 'not_ready' }
  }
  if (!isTelemetryEnabled()) {
    return { status: 'not_enrolled' }
  }
  const settings = store.getSettings()
  const ui = store.getUI()
  const installId = settings.telemetry?.installId
  if (
    !installId ||
    settings.browserExtensionsEnabled !== true ||
    ui.contextualToursSeenIds?.includes('browser-extensions') ||
    ui.featureInteractions?.['browser-extensions']
  ) {
    return { status: 'not_ready' }
  }
  const parsed = browserExtensionsBannerAssignmentSchema.safeParse(
    settings.telemetry?.browserExtensionsBanner
  )
  let saved = parsed.success ? parsed.data : null
  if (saved?.reported) {
    return { status: 'active', banner: saved.banner }
  }
  if (!saved) {
    saved = {
      banner: browserExtensionsBannerForInstall(installId),
      assignedAt: Date.now(),
      hadExtensions: getBrowserExtensionInstallStore().list().length > 0
    }
    try {
      save(store, saved, false)
      // Why before the event: a record lost in a crash would be redone with a later time.
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    } catch {
      // The record may or may not be on disk; the next launch resumes from whichever it finds.
      heldUntilNextLaunch = true
      try {
        save(store, undefined, false)
      } catch {
        // Nothing follows an unreported record this launch either way.
      }
      return { status: 'deferred' }
    }
  }
  let accepted = false
  try {
    accepted = track('browser_extensions_banner_assigned', {
      banner: saved.banner,
      had_extensions: saved.hadExtensions
    })
  } catch {
    // Treated like a refused event.
  }
  if (!accepted) {
    heldUntilNextLaunch = true
    return { status: 'deferred' }
  }
  try {
    save(store, { ...saved, reported: true }, true)
  } catch {
    heldUntilNextLaunch = true
    return { status: 'deferred' }
  }
  return { status: 'active', banner: saved.banner }
}

function save(
  store: Store,
  assignment: BrowserExtensionsBannerAssignment | undefined,
  notifyListeners: boolean
): void {
  const telemetry = store.getSettings().telemetry
  if (!telemetry) {
    throw new Error('telemetry settings missing')
  }
  // Why the whole block: windows replace their telemetry settings with what is broadcast.
  store.updateSettings(
    { telemetry: { ...telemetry, browserExtensionsBanner: assignment } },
    { notifyListeners }
  )
}

/** Call only after a new extension finished loading; updates and failed installs do not count. */
export function recordBrowserExtensionInstalled(source: 'web_store' | 'unpacked'): void {
  try {
    track('browser_extension_installed', { source })
  } catch {
    // Telemetry never costs an install.
  }
}

/** Reported once per launch. */
export function recordBrowserExtensionUsed(): void {
  if (usedThisSession) {
    return
  }
  usedThisSession = true
  try {
    track('browser_extension_used', {})
  } catch {
    // Telemetry never costs a click.
  }
}
