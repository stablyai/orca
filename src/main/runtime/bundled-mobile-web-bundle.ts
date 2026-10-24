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

/**
 * Probed like getBundledWebClientRoot. The bundle ships under out/ inside app.asar, so the
 * entrypoint layouts that move appPath move it. `ORCA_MOBILE_WEB_BUNDLE_DIR` wins when set.
 *
 * Read through the AppEnvironment port rather than `electron.app`, because this module is reachable
 * from the runtime's import graph and the runtime must stay bootable on plain Node. A host with no
 * environment installed has no install root, which is the same answer as having no bundle.
 */
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
    // Why: unpacked electron-vite entrypoints set appPath to out/main, next to the bundle.
    join(appPath, '..', 'mobile-web')
  ].filter((root): root is string => root !== undefined)
  return roots.find((root) => existsSync(join(root, MANIFEST_FILENAME)))
}

// `undefined` means unread, `null` means no usable bundle. Same root and mtime skip the parse.
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

  cachedBundle = readBundledMobileWebBundle(root)
  cachedMtimeMs = mtimeMs
  cachedRoot = root
  return cachedBundle
}

/** Tests own the process, so they own the cache; nothing in the app may call this. */
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
    // Why warn rather than throw: packaging already hash-verifies the bundle, so reaching here means
    // a dev or hand-edited out/, and an unusable bundle must degrade to "no bundle", never to a
    // crash on a path a phone can reach.
    console.warn(`[mobile-web-bundle] ${manifestPath} does not match the manifest contract:`, {
      issues: manifest.error.issues
    })
    return null
  }
  return { root, manifest: manifest.data }
}
