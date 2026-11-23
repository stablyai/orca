import { existsSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getAppEnvironment,
  hasAppEnvironment
} from '../../../../../shared/app-lifecycle/app-environment'
import {
  InstalledMobileWebBundleManifestSchema,
  MobileWebBundleCatalogGzipSchema
} from '../../../../../shared/mobile-web-bundle/manifest-contract'

const MANIFEST_FILENAME = 'manifest.json'

export type BundledMobileWebBundle = {
  root: string
  manifest: ReturnType<typeof InstalledMobileWebBundleManifestSchema.parse>
}

export function parseInstalledCatalogGzip(entry: {
  gzip?: unknown
  sha256: string
  byteLength: number
}) {
  const parsed = MobileWebBundleCatalogGzipSchema.safeParse(entry.gzip)
  return parsed.success &&
    parsed.data.rawSha256 === entry.sha256 &&
    parsed.data.rawByteLength === entry.byteLength
    ? parsed.data
    : null
}

/** AppEnvironment keeps runtime imports Node-safe; absent environment means no install root.
 * Probe packaged and unpacked entrypoint layouts like findBundledWebClientRoot. */
export function getBundledMobileWebBundleRoot(): string | undefined {
  if (!hasAppEnvironment()) {
    return undefined
  }
  const appPath = getAppEnvironment().getAppPath()
  if (probedRoot?.appPath === appPath) {
    return probedRoot.root
  }
  const root = bundleRoots(appPath).find((candidate) =>
    existsSync(join(candidate, MANIFEST_FILENAME))
  )
  if (root) {
    probedRoot = { appPath, root }
  }
  return root
}

function bundleRoots(appPath: string): string[] {
  // Electron reads app.asar paths through the header it parsed at launch, which misses files an in-place update wrote.
  const filesPath = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath
  return [
    join(filesPath, 'out', 'mobile-web'),
    // Unpacked electron-vite sets appPath to out/main.
    join(filesPath, '..', 'mobile-web')
  ]
}

let probedRoot: { appPath: string; root: string } | undefined

// Linux package managers replace the install under a running app, so the cache holds only while manifest.json's bytes do.
let cached: { root: string; raw: Buffer; bundle: BundledMobileWebBundle | null } | undefined

async function findBundleRoot(): Promise<string | undefined> {
  if (!hasAppEnvironment()) {
    return undefined
  }
  const appPath = getAppEnvironment().getAppPath()
  if (probedRoot?.appPath === appPath) {
    return probedRoot.root
  }
  for (const root of bundleRoots(appPath)) {
    const found = await access(join(root, MANIFEST_FILENAME)).then(
      () => true,
      () => false
    )
    if (found) {
      probedRoot = { appPath, root }
      return root
    }
  }
  return undefined
}

export async function loadBundledMobileWebBundle(): Promise<BundledMobileWebBundle | null> {
  const root = await findBundleRoot()
  if (!root) {
    return null
  }
  const manifestPath = join(root, MANIFEST_FILENAME)
  let raw: Buffer
  try {
    raw = await readFile(manifestPath)
  } catch (error) {
    console.warn(`[mobile-web-bundle] cannot read ${manifestPath}:`, error)
    return null
  }
  if (cached?.root !== root || !cached.raw.equals(raw)) {
    cached = {
      root,
      raw,
      bundle: parseBundledMobileWebBundle(root, manifestPath, raw.toString('utf8'))
    }
  }
  return cached.bundle
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
