import { ipcMain, net } from 'electron'
import { buildReleaseManifestUrl } from '../../shared/runtime-release-manifest'
import type { RuntimeUpdateGuideArch } from '../../shared/runtime-update-guide-templates'

// Why: the release-metadata lookup for the update advisor must run in main.
// The renderer loads from a file:// origin in packaged builds, and GitHub's
// `releases/latest/download` redirect lands on objects.githubusercontent.com,
// which does not send permissive CORS headers — a renderer fetch() would fail.
// Electron's `net` module runs in main and is not subject to CORS. The URL is
// built entirely from a client-owned platform/arch mapping, so the renderer can
// never steer this at an arbitrary host.

const RELEASE_MANIFEST_TIMEOUT_MS = 4_000
// electron-updater manifests are a few hundred bytes; cap the read so a
// misrouted redirect to a large object can't be slurped into memory.
const MAX_MANIFEST_BYTES = 64 * 1024

export type RuntimeReleaseManifestFetchArgs = {
  platform?: string
  arch?: RuntimeUpdateGuideArch
}

export type RuntimeReleaseManifestFetchResult = { ok: true; yaml: string } | { ok: false }

export async function fetchRuntimeReleaseManifest(
  args: RuntimeReleaseManifestFetchArgs | undefined
): Promise<RuntimeReleaseManifestFetchResult> {
  const url = buildReleaseManifestUrl(args?.platform, args?.arch)
  if (!url) {
    return { ok: false }
  }
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(RELEASE_MANIFEST_TIMEOUT_MS) })
    if (!res.ok) {
      return { ok: false }
    }
    const yaml = await res.text()
    if (yaml.length > MAX_MANIFEST_BYTES) {
      return { ok: false }
    }
    return { ok: true, yaml }
  } catch {
    // Best-effort: timeout, DNS failure, 404, and publish-window gaps all yield
    // version-less guidance, never an error surfaced into the compat gate.
    return { ok: false }
  }
}

export function registerRuntimeReleaseManifestHandlers(): void {
  ipcMain.removeHandler('runtimeReleaseManifest:fetch')
  ipcMain.handle('runtimeReleaseManifest:fetch', (_event, args: RuntimeReleaseManifestFetchArgs) =>
    fetchRuntimeReleaseManifest(args)
  )
}
