import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import { runProcess } from '@orca/process-host'
import {
  getOpenCodeCliCapabilities,
  type OpenCodeCliCapabilities
} from '../../shared/opencode-cli-version'

export type OpenCodeCliVersionProbe = {
  executablePath: string
  env: NodeJS.ProcessEnv
  cwd?: string
  hostIdentity?: string
  execute?: () => Promise<{ code: number | null; timedOut: boolean; stdout: string }>
}

const probes = new Map<string, { expiresAt: number; result: Promise<OpenCodeCliCapabilities> }>()
const CACHE_TTL_MS = 60_000
const MAX_CACHED_PROBES = 128
const PANE_IDENTITY_ENV_KEYS = new Set([
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV
])

export function probeOpenCodeCliVersion(
  options: OpenCodeCliVersionProbe
): Promise<OpenCodeCliCapabilities> {
  const identity = JSON.stringify([
    options.execute ? 'host-callback' : 'native-process',
    options.hostIdentity ?? process.platform,
    options.executablePath,
    options.cwd,
    Object.entries(options.env)
      .filter(([key]) => !PANE_IDENTITY_ENV_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
  ])
  const key = createHash('sha256').update(identity).digest('hex')
  const cached = probes.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result
  }
  const result = runVersionProbe(options)
  probes.delete(key)
  probes.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result })
  if (probes.size > MAX_CACHED_PROBES) {
    const oldest = probes.keys().next().value
    if (oldest !== undefined) {
      probes.delete(oldest)
    }
  }
  return result
}

async function runVersionProbe(options: OpenCodeCliVersionProbe): Promise<OpenCodeCliCapabilities> {
  try {
    const pathKey = process.platform === 'win32' && options.env.Path !== undefined ? 'Path' : 'PATH'
    const executableDir = path.dirname(options.executablePath)
    const inheritedPath = options.env[pathKey]
    const result = options.execute
      ? await options.execute()
      : await runProcess({
          program: options.executablePath,
          args: ['--version'],
          cwd: options.cwd,
          env: {
            ...options.env,
            [pathKey]: inheritedPath
              ? `${executableDir}${path.delimiter}${inheritedPath}`
              : executableDir
          },
          timeoutMs: 5_000,
          maxOutputBytes: 4_096
        })
    return getOpenCodeCliCapabilities(result.code === 0 && !result.timedOut ? result.stdout : null)
  } catch {
    return getOpenCodeCliCapabilities(null)
  }
}
