import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { toLinuxPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'

export async function readWslWorktreeMaterializationBundle(): Promise<string> {
  const roots: string[] = []
  if (process.env.ORCA_RELAY_PATH) {
    roots.push(process.env.ORCA_RELAY_PATH)
  }
  if (process.resourcesPath) {
    roots.push(join(process.resourcesPath, 'relay'))
  }
  try {
    roots.push(join(getAppEnvironment().getAppPath(), 'out', 'relay'))
  } catch {
    // Plain Node hosts can supply ORCA_RELAY_PATH.
  }
  for (const root of roots) {
    try {
      return await readFile(join(root, 'wsl', 'worktree-materialization.js'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }
  throw new Error('WSL workspace materialization bundle is unavailable')
}

export function buildWslWorktreeMaterializationScript(
  bundle: string,
  request: {
    source: string
    target: string
    linkedPaths: readonly string[]
    operation?: 'inspect-links' | 'remove-links'
  }
): string {
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64')
  // The runner sends large scripts over stdin; neither paths nor bundles enter shell interpolation.
  return `command -v node >/dev/null 2>&1 || { printf '%s' 'WSL workspace materialization requires Node.js 18 or newer' >&2; exit 127; }
node - <<'ORCA_WORKTREE_MATERIALIZATION_JS'
process.env.ORCA_WORKTREE_REQUEST = '${encoded}';
${bundle}
ORCA_WORKTREE_MATERIALIZATION_JS
`
}

async function requestWslWorktreePaths(
  distro: string,
  source: string,
  target: string,
  linkedPaths: readonly string[],
  deps = { readBundle: readWslWorktreeMaterializationBundle, run: runWslProcess },
  operation?: 'inspect-links' | 'remove-links'
): Promise<{ warning?: string; paths?: string[] }> {
  const bundle = await deps.readBundle()
  const result = await deps.run({
    distro,
    loginPath: 'preferred',
    script: buildWslWorktreeMaterializationScript(bundle, {
      source: toLinuxPath(source),
      target: toLinuxPath(target),
      linkedPaths,
      ...(operation ? { operation } : {})
    }),
    timeoutMs: 300_000,
    maxOutputBytes: 16 * 1024
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(
      `WSL workspace materialization is unverifiable. Workspace remains at "${target}". Confirm copying has exited before retrying. ${result.stderr.trim()}`
    )
  }
  let response: unknown
  try {
    response = JSON.parse(result.stdout)
  } catch {
    throw new Error('Invalid WSL workspace materialization response; completion is unverifiable')
  }
  if (
    !response ||
    typeof response !== 'object' ||
    !('supported' in response) ||
    response.supported !== true ||
    ('warning' in response && typeof response.warning !== 'string') ||
    (operation &&
      (!('paths' in response) ||
        !Array.isArray(response.paths) ||
        response.paths.some((path) => typeof path !== 'string')))
  ) {
    throw new Error('Invalid WSL workspace materialization response; completion is unverifiable')
  }
  return response as { warning?: string; paths?: string[] }
}

export async function materializeWslWorktreePaths(
  distro: string,
  source: string,
  target: string,
  linkedPaths: readonly string[],
  deps = { readBundle: readWslWorktreeMaterializationBundle, run: runWslProcess }
): Promise<string | undefined> {
  return (await requestWslWorktreePaths(distro, source, target, linkedPaths, deps)).warning
}

export async function inspectWslWorktreeSharedLinks(
  distro: string,
  source: string,
  target: string,
  linkedPaths: readonly string[],
  remove = false,
  deps = { readBundle: readWslWorktreeMaterializationBundle, run: runWslProcess }
): Promise<string[]> {
  return (
    (
      await requestWslWorktreePaths(
        distro,
        source,
        target,
        linkedPaths,
        deps,
        remove ? 'remove-links' : 'inspect-links'
      )
    ).paths ?? []
  )
}
