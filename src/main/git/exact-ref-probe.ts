import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'

export type ExactRefProbeExecOptions = {
  maxBuffer?: number
  timeoutMs?: number
}

export type ExactRefProbeExec = (
  argv: string[],
  options?: ExactRefProbeExecOptions
) => Promise<{ stdout: string }>

export type ExactRefProbeSetResult = {
  presentRefs: string[]
  absentRefs: string[]
  unknownRefs: string[]
}

type ExactRefPresence = 'present' | 'absent' | 'unknown'

const EXACT_REF_PROBE_CONCURRENCY = 8

export function isShowRefNoMatchError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined
  // Git reports a missing ref as numeric exit status 1. Keep string-valued
  // transport/error codes (including a relay that happens to use `"1"`) in
  // the unknown bucket so SSH loss cannot look like an absent ref.
  if (record?.code !== 1) {
    return false
  }
  // `--quiet` makes Git print nothing for a missing ref, but a wrapper that
  // also exits 1 always explains itself: `wsl.exe` on a dead distro, a relay
  // transport error. Empty stderr is what separates proven absence from a
  // probe that never ran. A runner that reports no stderr at all (the SSH
  // provider) keeps its existing exit-code contract.
  const stderr = record.stderr
  return stderr === undefined || stderr === null || String(stderr).trim().length === 0
}

function commandOptions(options: ExactRefProbeExecOptions): ExactRefProbeExecOptions | undefined {
  if (options.maxBuffer === undefined && options.timeoutMs === undefined) {
    return undefined
  }
  return { ...options }
}

async function probeExactRef(
  runGit: ExactRefProbeExec,
  ref: string,
  options: ExactRefProbeExecOptions
): Promise<ExactRefPresence> {
  if (!isSafeGitRefName(ref)) {
    return 'unknown'
  }
  try {
    const argv = ['show-ref', '--verify', '--quiet', '--', ref]
    const forwardedOptions = commandOptions(options)
    await (forwardedOptions ? runGit(argv, forwardedOptions) : runGit(argv))
    return 'present'
  } catch (error) {
    return isShowRefNoMatchError(error) ? 'absent' : 'unknown'
  }
}

/** Probe full ref names with bounded subprocess concurrency and exact lookups. */
export async function probeExactRefs(
  runGit: ExactRefProbeExec,
  refs: readonly string[],
  options: ExactRefProbeExecOptions = {}
): Promise<ExactRefProbeSetResult> {
  const uniqueRefs = [...new Set(refs)]
  const states: (ExactRefPresence | undefined)[] = Array.from(
    { length: uniqueRefs.length },
    () => undefined
  )
  let nextIndex = 0

  async function probeNext(): Promise<void> {
    while (true) {
      const index = nextIndex++
      if (index >= uniqueRefs.length) {
        return
      }
      const ref = uniqueRefs[index]
      states[index] = await probeExactRef(runGit, ref, options)
    }
  }

  const workerCount = Math.min(EXACT_REF_PROBE_CONCURRENCY, uniqueRefs.length)
  await Promise.all(Array.from({ length: workerCount }, () => probeNext()))
  for (let index = 0; index < states.length; index += 1) {
    states[index] ??= 'unknown'
  }
  return {
    presentRefs: uniqueRefs.filter((_, index) => states[index] === 'present'),
    absentRefs: uniqueRefs.filter((_, index) => states[index] === 'absent'),
    unknownRefs: uniqueRefs.filter((_, index) => states[index] === 'unknown')
  }
}

/** Stop scheduling exact lookups once any requested ref is present. */
export async function probeAnyExactRef(
  runGit: ExactRefProbeExec,
  refs: readonly string[],
  options: ExactRefProbeExecOptions = {}
): Promise<{ found: boolean; unknown: boolean }> {
  const uniqueRefs = [...new Set(refs)]
  let nextIndex = 0
  let found = false
  let unknown = false

  async function probeNext(): Promise<void> {
    while (!found) {
      const index = nextIndex++
      if (index >= uniqueRefs.length) {
        return
      }
      const ref = uniqueRefs[index]
      const state = await probeExactRef(runGit, ref, options)
      found ||= state === 'present'
      unknown ||= state === 'unknown'
    }
  }

  const workerCount = Math.min(EXACT_REF_PROBE_CONCURRENCY, uniqueRefs.length)
  await Promise.all(Array.from({ length: workerCount }, () => probeNext()))
  return { found, unknown }
}
