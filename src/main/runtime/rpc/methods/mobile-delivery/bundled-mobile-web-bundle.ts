import { readFileSync } from 'node:fs'
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

// An install keeps its layout, so only a miss is probed again (a dev build may produce the bundle later).
let probedRoot: { appPath: string; root: string } | undefined

// Once a manifest validates for this appPath, getStatus() advertises it with zero fs calls until an async load observes it gone/invalid.
let validatedRoot: { appPath: string; root: string } | undefined

// Linux package managers replace the install under a running app, so the cache holds only while manifest.json's bytes do.
let cached: { root: string; raw: Buffer; bundle: BundledMobileWebBundle | null } | undefined

/** Probe packaged and unpacked entrypoint layouts like findBundledWebClientRoot. */
function candidateBundleRoots(appPath: string): string[] {
  if (probedRoot?.appPath === appPath) {
    return [probedRoot.root]
  }
  // Electron reads app.asar paths through the header it parsed at launch, which misses files an in-place update wrote.
  const filesPath = appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath
  return [
    join(filesPath, 'out', 'mobile-web'),
    // Unpacked electron-vite sets appPath to out/main.
    join(filesPath, '..', 'mobile-web')
  ]
}

export async function loadBundledMobileWebBundle(): Promise<BundledMobileWebBundle | null> {
  if (!hasAppEnvironment()) {
    return null
  }
  const appPath = getAppEnvironment().getAppPath()
  for (const root of candidateBundleRoots(appPath)) {
    const manifestPath = join(root, MANIFEST_FILENAME)
    let raw: Buffer
    try {
      raw = await readFile(manifestPath)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        console.warn(`[mobile-web-bundle] cannot read ${manifestPath}:`, error)
      }
      continue
    }
    probedRoot = { appPath, root }
    const bundle = parseAndCacheBundledMobileWebBundle(root, manifestPath, raw)
    if (bundle) {
      validatedRoot = { appPath, root }
    } else if (validatedRoot?.appPath === appPath) {
      validatedRoot = undefined
    }
    return bundle
  }
  if (validatedRoot?.appPath === appPath) {
    validatedRoot = undefined
  }
  return null
}

/** Synchronous check for capability advertisement: only advertise when manifest.json parses and validates. */
export function hasValidBundledMobileWebBundle(): boolean {
  if (!hasAppEnvironment()) {
    return false
  }
  const appPath = getAppEnvironment().getAppPath()
  if (validatedRoot?.appPath === appPath) {
    return true
  }
  for (const root of candidateBundleRoots(appPath)) {
    const manifestPath = join(root, MANIFEST_FILENAME)
    let raw: Buffer
    try {
      raw = readFileSync(manifestPath)
    } catch {
      continue
    }
    probedRoot = { appPath, root }
    if (parseAndCacheBundledMobileWebBundle(root, manifestPath, raw) !== null) {
      validatedRoot = { appPath, root }
      return true
    }
    return false
  }
  return false
}

function parseAndCacheBundledMobileWebBundle(
  root: string,
  manifestPath: string,
  raw: Buffer
): BundledMobileWebBundle | null {
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
