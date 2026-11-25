// Whether a terminal agent's installed CLI takes the route Orca would hand it its servers by, learned
// once per binary (its real path and modification time) from `--help` or `--version`, so a CLI too
// old for the route starts as it would without Orca rather than failing on an option it doesn't know.
import { realpath, stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import {
  compareAppVersions,
  parseCliVersion
} from '../../../shared/app-lifecycle/identity/app-version'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { wslGuestDrivePath } from './terminal-mcp-launch-files'

/** What a launch waits for a first probe; later launches of the same binary read the cache. */
const PROBE_BUDGET_MS = 3_000
const PROBE_TIMEOUT_MS = 10_000

export type TerminalMcpCliRequirement =
  /** `--help` lists this option. */
  | { help: string }
  /** `--version` is at least this. */
  | { version: string }

export type TerminalMcpCliFact = 'supported' | 'unsupported' | 'unknown'

const facts = new BoundedMap<
  string,
  { fact: Promise<TerminalMcpCliFact>; expires?: number; refreshing?: Promise<TerminalMcpCliFact> }
>({
  maxEntries: 64
})

async function binaryKey(executable: string, env: Record<string, string>, cwd: string | undefined) {
  const found = await resolveCommandOnLocalPath(executable, { env, ...(cwd ? { cwd } : {}) })
  if (!found) {
    return null
  }
  const target = await realpath(found)
  return { path: found, key: `${target}\n${(await stat(target)).mtimeMs}` }
}

async function probe(
  path: string,
  requirement: TerminalMcpCliRequirement,
  env: Record<string, string>,
  cwd: string | undefined
): Promise<TerminalMcpCliFact> {
  const result = await runProcess({
    program: path,
    ...(cwd ? { cwd } : {}),
    args: ['help' in requirement ? '--help' : '--version'],
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: 256 * 1024,
    killOnOutputLimit: true,
    terminationBarrier: true
  }).catch(() => null)
  return factOf(result, requirement)
}

/** What a finished `--help` or `--version` run says; a failed run proves nothing (unknown). */
function factOf(
  result: {
    code: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    outputTruncated?: boolean
  } | null,
  requirement: TerminalMcpCliRequirement
): TerminalMcpCliFact {
  if (!result || result.timedOut || result.outputTruncated || result.code !== 0) {
    return 'unknown'
  }
  const output = `${result.stdout}\n${result.stderr}`
  if ('help' in requirement) {
    return output.includes(requirement.help) ? 'supported' : 'unsupported'
  }
  const version = parseCliVersion(output)
  return version === null
    ? 'unknown'
    : compareAppVersions(version, requirement.version) >= 0
      ? 'supported'
      : 'unsupported'
}

async function within<T>(pending: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([pending, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Whether `executable`, as `env` and `cwd` find it on this host, meets `requirement`. */
export async function terminalMcpCliSupports(
  executable: string,
  requirement: TerminalMcpCliRequirement,
  env: Record<string, string>,
  cwd: string | undefined
): Promise<TerminalMcpCliFact> {
  const binary = await binaryKey(executable, env, cwd).catch(() => null)
  if (!binary) {
    return 'unknown'
  }
  // By folder too: a version manager's shim runs whichever version that folder pins.
  const key = `${binary.key}\n${cwd ?? ''}\n${JSON.stringify(requirement)}`
  return cached(key, () => probe(binary.path, requirement, env, cwd))
}

/** The fact for `key`, probing once; only a definite answer is kept, an unknown one is retried by
 *  the next launch. A WSL guest's binary has no stat from here, so its answer lasts a while only. */
function cached(
  key: string,
  run: () => Promise<TerminalMcpCliFact>,
  ttlMs?: number
): Promise<TerminalMcpCliFact> {
  const kept = facts.get(key)
  if (kept && (kept.expires === undefined || kept.expires > Date.now())) {
    return within(kept.fact, PROBE_BUDGET_MS, 'unknown')
  }
  if (kept) {
    // An expired answer still serves this launch while one shared read gets the next.
    if (!kept.refreshing) {
      kept.refreshing = run()
      void kept.refreshing.then((settled) => {
        if (facts.peek(key) !== kept) {
          return
        }
        if (settled === 'unknown') {
          kept.refreshing = undefined
        } else {
          facts.set(key, { fact: Promise.resolve(settled), expires: Date.now() + (ttlMs ?? 0) })
        }
      })
    }
    return within(kept.fact, PROBE_BUDGET_MS, 'unknown')
  }
  const fact = run()
  const entry = { fact, ...(ttlMs ? { expires: Date.now() + ttlMs } : {}) }
  facts.set(key, entry)
  void fact.then((settled) => {
    if (settled === 'unknown' && facts.peek(key) === entry) {
      facts.delete(key)
    }
  })
  return within(fact, PROBE_BUDGET_MS, 'unknown')
}

const WSL_FACT_TTL_MS = 10 * 60_000

/** Whether `executable`, as `distro`'s login PATH finds it from the terminal's folder, meets
 *  `requirement`. A run without the login PATH proves nothing: the distro's fallback PATH may hold
 *  another install. */
export function terminalMcpCliSupportsInWsl(
  executable: string,
  requirement: TerminalMcpCliRequirement,
  distro: string | null,
  hostCwd: string | undefined
): Promise<TerminalMcpCliFact> {
  const wslPath = hostCwd ? parseWslUncPath(hostCwd) : null
  // A Windows folder goes through the distro's own drive mount, as the launch files do.
  const cwd = hostCwd
    ? (wslPath?.linuxPath ?? wslGuestDrivePath(distro, hostCwd) ?? hostCwd)
    : undefined
  const guestCwd = cwd?.startsWith('/') ? cwd : undefined
  const guestDistro = wslPath?.distro ?? distro
  // By folder too: a project's own install or a version manager's shim answers for that folder.
  const key = `wsl\n${guestDistro ?? ''}\n${guestCwd ?? ''}\n${executable}\n${JSON.stringify(requirement)}`
  return cached(
    key,
    async () => {
      const result = await runWslProcess({
        ...(guestDistro ? { distro: guestDistro } : {}),
        ...(guestCwd ? { cwd: guestCwd } : {}),
        program: executable,
        args: ['help' in requirement ? '--help' : '--version'],
        loginPath: 'preferred',
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: 256 * 1024
      }).catch(() => null)
      return factOf(result?.environmentResolved ? result : null, requirement)
    },
    WSL_FACT_TTL_MS
  )
}
