import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import {
  MobileWebBundleManifestSchema,
  type MobileWebBundleManifest
} from '../../shared/mobile-web-bundle/manifest-contract'

const MANIFEST_FILENAME = 'manifest.json'

export type BundledMobileWebBundle = {
  root: string
  manifest: MobileWebBundleManifest
}

/** AppEnvironment keeps runtime imports Node-safe; absent environment means no install root.
 * Probe app.asar/out and unpacked entrypoint layouts like getBundledWebClientRoot. */
export function getBundledMobileWebBundleRoot(): string | undefined {
  if (!hasAppEnvironment()) {
    return undefined
  }
  const appPath = getAppEnvironment().getAppPath()
  const roots = [
    join(appPath, 'out', 'mobile-web'),
    // Unpacked electron-vite sets appPath to out/main.
    join(appPath, '..', 'mobile-web')
  ]
  return roots.find((root) => existsSync(join(root, MANIFEST_FILENAME)))
}

// Installs are immutable until restart; undefined means unprobed, null means absent.
let cachedBundle: BundledMobileWebBundle | null | undefined

export function loadBundledMobileWebBundle(): BundledMobileWebBundle | null {
  if (cachedBundle === undefined) {
    cachedBundle = readBundledMobileWebBundle()
  }
  return cachedBundle
}

export function resetBundledMobileWebBundleCacheForTests(): void {
  cachedBundle = undefined
}

function readBundledMobileWebBundle(): BundledMobileWebBundle | null {
  const root = getBundledMobileWebBundleRoot()
  if (!root) {
    return null
  }
  const manifestPath = join(root, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    console.warn(`[mobile-web-bundle] cannot read ${manifestPath}:`, error)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn(`[mobile-web-bundle] ${manifestPath} is not valid JSON:`, error)
    return null
  }
  const manifest = MobileWebBundleManifestSchema.safeParse(parsed)
  if (!manifest.success) {
    // Bad dev/hand-edited bundles must degrade to absent, not crash a phone-accessible path.
    console.warn(`[mobile-web-bundle] ${manifestPath} does not match the manifest contract:`, {
      issues: manifest.error.issues
    })
    return null
  }
  return { root, manifest: manifest.data }
}
