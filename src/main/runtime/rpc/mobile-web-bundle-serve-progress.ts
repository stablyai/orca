import type { MobileWebBundleManifest } from '../../../shared/mobile-web-bundle/manifest-contract'

type AssetProgress = { offsets: Set<number>; servedBytes: number; complete: boolean }

type BuildProgress = {
  buildId: string
  assets: Map<string, AssetProgress>
  completeAssets: number
  startedAt: number
}

/** `started`: the first window of a download; `fullyServed`: every manifest asset is now read. */
export type MobileWebBundleWindowVerdict = {
  started: boolean
  fullyServed: boolean
  elapsedMs: number
}

// Why bounded: one entry per device that started a download; a host never needs more.
const MAX_TRACKED_DEVICES = 16

/** Total asset bytes in a manifest, for the trace line. */
export function mobileWebBundleTotalBytes(manifest: MobileWebBundleManifest): number {
  return manifest.assets.reduce((sum, asset) => sum + asset.byteLength, 0)
}

/**
 * Which windows of the bundle each device has been served, so "every asset fully read" can be
 * reported once. Keyed by device, not connection: a phone may resume a download after reconnecting.
 */
export class MobileWebBundleServeProgress {
  private readonly devices = new Map<string, BuildProgress>()

  constructor(private readonly now: () => number) {}

  /** Records one served window; offsets are deduped so a retried window is not counted twice. */
  windowServed(
    deviceKey: string,
    manifest: MobileWebBundleManifest,
    path: string,
    offset: number,
    byteLength: number
  ): MobileWebBundleWindowVerdict {
    let progress = this.devices.get(deviceKey)
    let started = false
    if (!progress || progress.buildId !== manifest.buildId) {
      progress = {
        buildId: manifest.buildId,
        assets: new Map(),
        completeAssets: 0,
        startedAt: this.now()
      }
      this.track(deviceKey, progress)
      started = true
    }
    const declared = manifest.assets.find((asset) => asset.path === path)
    if (declared) {
      let asset = progress.assets.get(path)
      if (!asset) {
        asset = { offsets: new Set(), servedBytes: 0, complete: false }
        progress.assets.set(path, asset)
      }
      if (!asset.offsets.has(offset)) {
        asset.offsets.add(offset)
        asset.servedBytes += byteLength
      }
      if (!asset.complete && asset.servedBytes >= declared.byteLength) {
        asset.complete = true
        progress.completeAssets += 1
      }
    }
    const elapsedMs = this.now() - progress.startedAt
    if (progress.completeAssets >= manifest.assets.length) {
      // Why delete: a later full re-download is a new attempt and must be reported again.
      this.devices.delete(deviceKey)
      return { started, fullyServed: true, elapsedMs }
    }
    return { started, fullyServed: false, elapsedMs }
  }

  private track(deviceKey: string, progress: BuildProgress): void {
    this.devices.delete(deviceKey)
    this.devices.set(deviceKey, progress)
    if (this.devices.size > MAX_TRACKED_DEVICES) {
      const oldest = this.devices.keys().next().value
      if (oldest !== undefined) {
        this.devices.delete(oldest)
      }
    }
  }
}
