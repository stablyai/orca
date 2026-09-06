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
// SHA-1 and SHA-256 repositories both report a full object id here.
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

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

/** Runs Git with a stdin payload. Only hosts that can feed a child's stdin supply one. */
export type ExactRefProbeStdinExec = (
  argv: string[],
  options: ExactRefProbeExecOptions & { stdin: string }
) => Promise<{ stdout: string }>

/** `cat-file --batch-check` reports every ref from one child, and reports a missing ref as data
 *  rather than a failed exit — so a batch stays as decidable as a per-ref `show-ref --verify`.
 *  A repo with many remotes otherwise pays one subprocess per remote on every conflict check. */
export async function probeAnyExactRefBatched(
  runGit: ExactRefProbeStdinExec,
  refs: readonly string[],
  options: ExactRefProbeExecOptions = {}
): Promise<{ found: boolean; unknown: boolean }> {
  const uniqueRefs = [...new Set(refs)]
  const safeRefs = uniqueRefs.filter((ref) => isSafeGitRefName(ref))
  if (safeRefs.length === 0) {
    return { found: false, unknown: uniqueRefs.length > 0 }
  }
  let stdout: string
  try {
    ;({ stdout } = await runGit(['cat-file', '--batch-check'], {
      ...options,
      stdin: `${safeRefs.join('\n')}\n`
    }))
  } catch {
    return { found: false, unknown: true }
  }
  // Trim per line so a CRLF-translating host's `\r` does not become part of the type.
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  // One line per input, in order; a short read means the batch never answered for the rest.
  if (lines.length !== safeRefs.length) {
    return { found: false, unknown: true }
  }
  let unknown = safeRefs.length !== uniqueRefs.length
  for (const line of lines) {
    const [head, type] = line.split(' ')
    if (OBJECT_ID_PATTERN.test(head) && type !== undefined && type !== 'missing') {
      return { found: true, unknown: false }
    }
    if (type !== 'missing') {
      // `ambiguous`, or a spelling this Git reports differently; neither proves absence.
      unknown = true
    }
  }
  return { found: false, unknown }
}
