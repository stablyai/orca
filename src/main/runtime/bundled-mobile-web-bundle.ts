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

/**
 * Probed exactly like getBundledWebClientRoot: the bundle ships inside app.asar under out/, so the
 * two entrypoint layouts that move appPath are the only ones that can move it.
 *
 * Read through the AppEnvironment port rather than `electron.app`, because this module is reachable
 * from the runtime's import graph and the runtime must stay bootable on plain Node. A host with no
 * environment installed has no install root, which is the same answer as having no bundle.
 */
export function getBundledMobileWebBundleRoot(): string | undefined {
  if (!hasAppEnvironment()) {
    return undefined
  }
  const appPath = getAppEnvironment().getAppPath()
  const roots = [
    join(appPath, 'out', 'mobile-web'),
    // Why: unpacked electron-vite entrypoints set appPath to out/main, next to the bundle.
    join(appPath, '..', 'mobile-web')
  ]
  return roots.find((root) => existsSync(join(root, MANIFEST_FILENAME)))
}

// Why no invalidation: the bundle is immutable for the life of the install, and an auto-update
// replaces it only by restarting the app, so a stale entry cannot outlive the process that read it.
// `undefined` means "not looked at yet", `null` means "looked, and this install has no bundle".
let cachedBundle: BundledMobileWebBundle | null | undefined

export function loadBundledMobileWebBundle(): BundledMobileWebBundle | null {
  if (cachedBundle === undefined) {
    cachedBundle = readBundledMobileWebBundle()
  }
  return cachedBundle
}

/** Tests own the process, so they own the cache; nothing in the app may call this. */
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
