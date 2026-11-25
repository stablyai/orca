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

/** What a launch waits for a first probe; later launches of the same binary read the cache. */
const PROBE_BUDGET_MS = 3_000
const PROBE_TIMEOUT_MS = 10_000

export type TerminalMcpCliRequirement =
  /** `--help` lists this option. */
  | { help: string }
  /** `--version` is at least this. */
  | { version: string }

export type TerminalMcpCliFact = 'supported' | 'unsupported' | 'unknown'

const facts = new BoundedMap<string, Promise<TerminalMcpCliFact>>({ maxEntries: 64 })

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
  // A run that failed proves nothing about its options; the next launch asks again.
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
  let fact = facts.get(key)
  if (!fact) {
    fact = probe(binary.path, requirement, env, cwd)
    facts.set(key, fact)
    // Only a definite answer is kept; an unknown one is retried by the next launch.
    void fact.then((settled) => {
      if (settled === 'unknown' && facts.peek(key) === fact) {
        facts.delete(key)
      }
    })
  }
  return within(fact, PROBE_BUDGET_MS, 'unknown')
}
