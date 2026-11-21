import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getAppEnvironment,
  hasAppEnvironment
} from '../../../../../shared/app-lifecycle/app-environment'
import {
  InstalledMobileWebBundleManifestSchema,
  type MobileWebBundleManifest
} from '../../../../../shared/mobile-web-bundle/manifest-contract'

const MANIFEST_FILENAME = 'manifest.json'

export type BundledMobileWebBundle = {
  root: string
  manifest: MobileWebBundleManifest
}

let probedRoot: { appPath: string; root: string } | undefined

// Same root and mtime skip the read. Identical bytes skip the parse. A failed re-read must not
// replace a bundle already served: Linux package managers replace the install under a running app.
let cached: { root: string; raw: Buffer; mtimeMs: number; bundle: BundledMobileWebBundle | null } | undefined

/** AppEnvironment keeps runtime imports Node-safe; absent environment means no install root.
 * Probe app.asar/out, repo, and unpacked entrypoint layouts like getBundledWebClientRoot and
 * findBundledWebClientRoot. The bundle ships under out/ inside app.asar, so layouts that move
 * appPath move it. `ORCA_MOBILE_WEB_BUNDLE_DIR` wins when set. */
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
  if (probedRoot?.appPath === appPath) {
    return probedRoot.root
  }
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
  // Electron reads app.asar paths through the header it parsed at launch, which misses files an in-place update wrote.
  const filesPath = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath
  const roots = [
    repoBundle,
    unpackedAsarBundle,
    join(filesPath, 'out', 'mobile-web'),
    // Unpacked electron-vite sets appPath to out/main.
    join(filesPath, '..', 'mobile-web'),
    filesPath === appPath ? undefined : join(appPath, 'out', 'mobile-web')
  ].filter((root): root is string => root !== undefined)
  const root = roots.find((candidate) => existsSync(join(candidate, MANIFEST_FILENAME)))
  // An install keeps its layout, so only a miss is probed again (a dev build may produce the bundle later).
  if (root) {
    probedRoot = { appPath, root }
  }
  return root
}

export function resetBundledMobileWebBundleCacheForTests(): void {
  probedRoot = undefined
  cached = undefined
}

export async function loadBundledMobileWebBundle(): Promise<BundledMobileWebBundle | null> {
  const root = getBundledMobileWebBundleRoot()
  if (!root) {
    cached = undefined
    return null
  }

  const manifestPath = join(root, MANIFEST_FILENAME)
  let mtimeMs: number | undefined
  try {
    mtimeMs = statSync(manifestPath).mtimeMs
  } catch {
    // Gone between existsSync and stat: keep the phone path from throwing.
  }

  if (mtimeMs !== undefined && cached?.root === root && cached.mtimeMs === mtimeMs) {
    return cached.bundle
  }

  let raw: Buffer
  try {
    raw = await readFile(manifestPath)
  } catch (error) {
    console.warn(`[mobile-web-bundle] cannot read ${manifestPath}:`, error)
    return cached?.root === root ? cached.bundle : null
  }

  if (cached?.root === root && cached.raw.equals(raw)) {
    if (mtimeMs !== undefined) {
      cached.mtimeMs = mtimeMs
    }
    return cached.bundle
  }

  const bundle = parseBundledMobileWebBundle(root, manifestPath, raw.toString('utf8'))
  if (bundle !== null || cached === undefined || cached.root !== root) {
    cached = { root, raw, mtimeMs: mtimeMs ?? Number.NaN, bundle }
  }
  return cached.root === root ? cached.bundle : bundle
}

function parseBundledMobileWebBundle(
  root: string,
  manifestPath: string,
  raw: string
): BundledMobileWebBundle | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn(`[mobile-web-bundle] ${manifestPath} is not valid JSON:`, error)
    return null
  }
  const manifest = InstalledMobileWebBundleManifestSchema.safeParse(parsed)
  if (!manifest.success) {
    // Bad dev/hand-edited bundles must degrade to absent, not crash a phone-accessible path.
    console.warn(`[mobile-web-bundle] ${manifestPath} does not match the manifest contract:`, {
      issues: manifest.error.issues
    })
    return null
  }
  return { root, manifest: manifest.data }
}
