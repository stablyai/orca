import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import type { NpmPackageInfo, NpmPackageInfoResult } from '../../shared/npm-package-info-types'
import type { Store } from '../persistence'
import { resolveRegisteredWorktreePath } from '../ipc/registered-worktree-roots-cache'
import { extractRepositoryUrl, toHttpsUrl } from './npm-manifest-urls'

const NPM_VIEW_TIMEOUT_MS = 8000

/**
 * Why an allowlist instead of `process.env`: a project `.npmrc` committed in a
 * repository can point npm at any host AND substitute `${VAR}` from the child
 * environment, so forwarding the parent environment would hand a hostile
 * repository whatever secret it names the moment someone hovers a dependency.
 */
const NPM_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS'
]

function buildNpmEnv(program: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of NPM_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  // Why pinned: corepack's npm wrapper rewrites the user's package.json to pin
  // a packageManager field unless auto-pin/project-spec are disabled.
  env.COREPACK_ENABLE_AUTO_PIN = '0'
  env.COREPACK_ENABLE_PROJECT_SPEC = '0'
  // Why withCliRuntimeOnPath: a version-manager npm carries a
  // `#!/usr/bin/env node` shebang, so without pinning its own runtime it can
  // execute under an unrelated node (orca#10932).
  return withCliRuntimeOnPath(program, env)
}

/**
 * The project `.npmrc` decides which host `npm view` talks to. Anything but
 * https is refused and the caller degrades to the public registry, so a
 * repository cannot aim a hover at a plaintext host of its choosing.
 */
async function resolvesToHttpsRegistry(program: string, cwd: string): Promise<boolean> {
  const probe = await runProcess({
    program,
    args: ['config', 'get', 'registry'],
    cwd,
    env: buildNpmEnv(program),
    timeoutMs: NPM_VIEW_TIMEOUT_MS
  })
  if (probe.timedOut || probe.code !== 0) {
    return false
  }
  try {
    return new URL(probe.stdout.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Extends the shared result contract with a signal private to this module:
 * the orchestration service (Phase 1.5) reads it to fall back to the HTTP
 * registry path when the local host has no resolvable npm binary at all.
 */
export type NpmCliPackageViewResult = NpmPackageInfoResult | { status: 'npm-unresolvable' }

function parseManifest(packageName: string, stdout: string): NpmPackageInfo | null {
  try {
    const manifest = JSON.parse(stdout) as Record<string, unknown>
    // Why the bracketed key: with field selectors npm returns a flat object
    // keyed by the literal selectors, so `dist-tags.latest` is one key rather
    // than a nested path.
    const latestVersion =
      typeof manifest['dist-tags.latest'] === 'string'
        ? (manifest['dist-tags.latest'] as string)
        : typeof manifest.version === 'string'
          ? manifest.version
          : null
    const time = manifest.time as Record<string, unknown> | undefined
    return {
      packageName,
      description: typeof manifest.description === 'string' ? manifest.description : null,
      latestVersion,
      latestPublishedAt:
        latestVersion && typeof time?.[latestVersion] === 'string'
          ? (time[latestVersion] as string)
          : null,
      homepageUrl: toHttpsUrl(manifest.homepage),
      repositoryUrl: extractRepositoryUrl(manifest.repository),
      source: 'npm-cli'
    }
  } catch {
    return null
  }
}

/**
 * Runs the local npm CLI (`npm view --json -- <pkg> <fields>`) to read registry
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
    if (!(await resolvesToHttpsRegistry(program, cwd))) {
      return { status: 'npm-unresolvable' }
    }
    result = await runProcess({
      program,
      // Why the explicit field list: a bare `npm view <pkg> --json` returns the
      // latest version's manifest, which carries no publish dates. Selectors
      // are what make npm include `time`. `--` keeps a package name that
      // begins with a dash from being read as a flag.
      args: [
        'view',
        '--json',
        '--silent',
        '--',
        packageName,
        'description',
        'dist-tags.latest',
        'homepage',
        'version',
        'time',
        'repository'
      ],
      cwd,
      env: buildNpmEnv(program),
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
