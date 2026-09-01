import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { NpmPackageInfo, NpmPackageInfoResult } from '../../shared/npm-package-info-types'
import type { Store } from '../persistence'
import { resolveRegisteredWorktreePath } from '../ipc/registered-worktree-roots-cache'

const NPM_VIEW_TIMEOUT_MS = 8000

/**
 * Extends the shared result contract with a signal private to this module:
 * the orchestration service (Phase 1.5) reads it to fall back to the HTTP
 * registry path when the local host has no resolvable npm binary at all.
 */
export type NpmCliPackageViewResult = NpmPackageInfoResult | { status: 'npm-unresolvable' }

/** Extracts an `https:` URL from a raw string, or `null` for anything else. */
function toHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** npm's `repository` manifest field is either a string or `{ type, url }`. */
function extractRepositoryUrl(repository: unknown): string | null {
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && 'url' in repository
        ? (repository as { url?: unknown }).url
        : null
  return typeof raw === 'string' ? toHttpsUrl(raw.replace(/^git\+/, '')) : null
}

function parseManifest(packageName: string, stdout: string): NpmPackageInfo | null {
  try {
    const manifest = JSON.parse(stdout) as Record<string, unknown>
    return {
      packageName,
      description: typeof manifest.description === 'string' ? manifest.description : null,
      latestVersion: typeof manifest.version === 'string' ? manifest.version : null,
      // `npm view <pkg> --json` (no field selector) does not include publish
      // dates in the returned single-version manifest.
      latestPublishedAt: null,
      homepageUrl: toHttpsUrl(manifest.homepage),
      repositoryUrl: extractRepositoryUrl(manifest.repository),
      source: 'npm-cli'
    }
  } catch {
    return null
  }
}

/**
 * Runs the local npm CLI (`npm view <pkg> --json --silent`) to read registry
 * metadata as configured by the host's own `.npmrc` (private registries,
 * scopes, auth) — the same source of truth VS Code uses.
 */
export async function npmCliPackageView(
  packageName: string,
  worktreeRoot: string,
  store: Store
): Promise<NpmCliPackageViewResult> {
  const program = resolveCliCommand('npm')

  let cwd: string
  try {
    cwd = await resolveRegisteredWorktreePath(worktreeRoot, store)
  } catch {
    return { status: 'unavailable', reason: 'host-unresolved' }
  }

  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess({
      program,
      args: ['view', packageName, '--json', '--silent'],
      cwd,
      // Why pinned: corepack's npm wrapper rewrites the user's package.json to
      // pin a packageManager field unless auto-pin/project-spec are disabled.
      env: { ...process.env, COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_ENABLE_PROJECT_SPEC: '0' },
      timeoutMs: NPM_VIEW_TIMEOUT_MS
    })
  } catch (error) {
    // Why ENOENT is distinct: `resolveCliCommand` never returns null, so a
    // spawn-time ENOENT is the only signal that no npm binary actually
    // exists on this host — the service falls back to the HTTP path on it.
    const isEnoent = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    return isEnoent ? { status: 'npm-unresolvable' } : { status: 'unavailable', reason: 'error' }
  }

  if (result.timedOut) {
    return { status: 'unavailable', reason: 'timeout' }
  }
  if (result.code !== 0) {
    if (result.stderr.includes('E404') || result.stdout.includes('E404')) {
      return { status: 'not-found' }
    }
    return { status: 'unavailable', reason: 'error' }
  }

  const info = parseManifest(packageName, result.stdout)
  return info ? { status: 'ok', info } : { status: 'unavailable', reason: 'error' }
}
