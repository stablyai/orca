import { existsSync as realExistsSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveChromiumCookiesPath,
  type DiscoveredBrowserCandidate
} from './installed-browser-discovery'

// A hardcoded, maintained browser entry with its data dir already resolved.
export type KnownBrowserEntry = {
  family: string
  label: string
  dataDir: string
  keychainService: string
  keychainAccount: string
}

export type ResolvedBrowser = {
  family: string
  customBrowserId?: string
  label: string
  dataDir: string
  keychainService: string
  keychainAccount: string
}

export type BrowserResolution =
  | { status: 'resolved'; browser: ResolvedBrowser }
  | { status: 'needs-setup'; customBrowserId: string; label: string; appPath: string }

// Data-root equality: fold trailing separators and case (macOS/Windows are case-insensitive).
function sameDataDir(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[/\\]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// Resolve a discovered candidate to an importable config via the ladder:
// (a) matches a maintained hardcoded entry → reuse it; (b) standard convention;
// (c) neither → needs-setup (let the user confirm the folder/keychain, never guess).
export function resolveBrowserCandidate(
  candidate: DiscoveredBrowserCandidate,
  opts: {
    knownBrowsers: KnownBrowserEntry[]
    appSupportRoot: string
    existsSync?: typeof realExistsSync
  }
): BrowserResolution {
  const existsSync = opts.existsSync ?? realExistsSync
  const conventionDir = join(opts.appSupportRoot, candidate.displayName)

  // (a) Known fast path — the verified keychain/paths beat a convention guess.
  const known = opts.knownBrowsers.find((entry) => sameDataDir(entry.dataDir, conventionDir))
  if (known) {
    return {
      status: 'resolved',
      browser: {
        family: known.family,
        label: known.label,
        dataDir: known.dataDir,
        keychainService: known.keychainService,
        keychainAccount: known.keychainAccount
      }
    }
  }

  // (b) Standard convention: <AppSupport>/<Name>, keychain "<Name> Safe Storage".
  if (
    existsSync(join(conventionDir, 'Local State')) &&
    resolveChromiumCookiesPath(join(conventionDir, 'Default'), existsSync) !== null
  ) {
    return {
      status: 'resolved',
      browser: {
        family: 'custom',
        customBrowserId: candidate.bundleId,
        label: candidate.displayName,
        dataDir: conventionDir,
        keychainService: `${candidate.displayName} Safe Storage`,
        keychainAccount: candidate.displayName
      }
    }
  }

  // (c) Convention missed — surface for user confirmation instead of guessing.
  return {
    status: 'needs-setup',
    customBrowserId: candidate.bundleId,
    label: candidate.displayName,
    appPath: candidate.appPath
  }
}

// Build a resolution from an explicit user-supplied folder + keychain (the needs-setup path).
export function resolveWithUserOverride(
  candidate: DiscoveredBrowserCandidate,
  override: { dataDir: string; keychainService: string; keychainAccount?: string }
): BrowserResolution {
  return {
    status: 'resolved',
    browser: {
      family: 'custom',
      customBrowserId: candidate.bundleId,
      label: candidate.displayName,
      dataDir: override.dataDir,
      keychainService: override.keychainService,
      keychainAccount: override.keychainAccount ?? candidate.displayName
    }
  }
}
