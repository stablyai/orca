import { existsSync, readFileSync, statSync } from 'node:fs'
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
 * Probe app.asar/out and unpacked entrypoint layouts like getBundledWebClientRoot. The bundle
 * ships under out/ inside app.asar, so layouts that move appPath move it.
 * `ORCA_MOBILE_WEB_BUNDLE_DIR` wins when set. */
export function getBundledMobileWebBundleRoot(): string | undefined {
  const override = process.env.ORCA_MOBILE_WEB_BUNDLE_DIR
  if (override && existsSync(join(override, MANIFEST_FILENAME))) {
    return override
  }
  if (!hasAppEnvironment()) {
    return undefined
  }
  const environment = getAppEnvironment()
  const appPath = environment.getAppPath()
  // Why: resources/app in dist/win-unpacked is four levels under the repo, and an unpackaged
  // app path uses the same relative probe. `build:mobile-web` refreshes that out/ in place.
  // A packaged install must not look outside itself.
  const repoBundle =
    appPath.includes('win-unpacked') || !environment.isPackaged()
      ? join(appPath, '..', '..', '..', '..', 'out', 'mobile-web')
      : undefined
  const unpackedAsarBundle =
    appPath.endsWith('.asar') || appPath.includes('app.asar')
      ? join(appPath, '..', 'app.asar.unpacked', 'out', 'mobile-web')
      : undefined
  const roots = [
    repoBundle,
    unpackedAsarBundle,
    join(appPath, 'out', 'mobile-web'),
    // Unpacked electron-vite sets appPath to out/main.
    join(appPath, '..', 'mobile-web')
  ].filter((root): root is string => root !== undefined)
  return roots.find((root) => existsSync(join(root, MANIFEST_FILENAME)))
}

// `undefined` means unprobed, `null` means absent (no usable bundle). Same root and mtime skip the parse.
let cachedBundle: BundledMobileWebBundle | null | undefined
let cachedMtimeMs: number | undefined
let cachedRoot: string | undefined

export function loadBundledMobileWebBundle(): BundledMobileWebBundle | null {
  const root = getBundledMobileWebBundleRoot()
  if (!root) {
    cachedBundle = null
    cachedMtimeMs = undefined
    cachedRoot = undefined
    return null
  }

  const manifestPath = join(root, MANIFEST_FILENAME)
  let mtimeMs = 0
  try {
    mtimeMs = statSync(manifestPath).mtimeMs
  } catch {
    // Gone between existsSync and stat: keep the phone path from throwing.
  }

  if (cachedBundle !== undefined && cachedRoot === root && cachedMtimeMs === mtimeMs) {
    return cachedBundle
  }

  const nextBundle = readBundledMobileWebBundle(root)
  if (nextBundle !== null || cachedBundle === undefined) {
    cachedBundle = nextBundle
    cachedMtimeMs = mtimeMs
    cachedRoot = root
  }
  return cachedBundle
}

export function resetBundledMobileWebBundleCacheForTests(): void {
  cachedBundle = undefined
  cachedMtimeMs = undefined
  cachedRoot = undefined
}

function readBundledMobileWebBundle(root: string): BundledMobileWebBundle | null {
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
