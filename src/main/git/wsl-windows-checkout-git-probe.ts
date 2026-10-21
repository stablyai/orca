import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import { resolveSelectedLocalCommand } from '../ipc/command-path-resolver'
import { runWslProcess, type WslResult, type WslSpec } from '../wsl/wsl-runner'
import { translateArgForWsl } from './command-runner/wsl-path-translation'
import { acquireGitAdmission } from './command-runner/git-subprocess-admission'
import { nonInteractiveGitEnv } from './command-runner/git-process-env'
import type { GitAdmissionTier } from './command-runner/git-exec-options'
import { isWslDirectGitReadCommand } from './wsl-direct-git-read-commands'
import {
  classifyLineEndingSample,
  forgetLineEndingSample,
  getWslWindowsCheckoutState,
  isFresh,
  isWslWindowsCheckoutCandidate,
  LINE_ENDING_SAMPLE_LIMIT,
  LINE_ENDING_SCAN_LIMIT,
  parseHostAutocrlf,
  recordHostAutocrlf,
  recordLineEndingSample,
  writesAnotherCheckout,
  wslWindowsCheckoutKey,
  type HostAutocrlfAnswer,
  type LineEndingSampleAnswer
} from './wsl-windows-checkout-git-config'

const HOST_PROBE_TIMEOUT_MS = 5_000
const SAMPLE_PROBE_TIMEOUT_MS = 15_000
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 10 * 60_000
const HOST_CONFIG_ARGS = ['config', '--show-origin', '--get-regexp', '^core\\.(autocrlf|eol)$']
// Exit 3 carries rev-parse's own diagnostic. The first head bounds what git reads even when grep
// matches nothing; the second bounds the sample.
export const SAMPLE_SCRIPT = [
  'git -C "$1" rev-parse --is-inside-work-tree >/dev/null || exit 3',
  "tab=$(printf '\\t')",
  'git -C "$1" ls-files --eol | head -n "$3" | grep "^i/lf  *w/[a-z]*  *attr/ *$tab" | head -n "$2"'
].join('\n')

export type HostGitResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type WslWindowsCheckoutProbeDeps = {
  platform?: NodeJS.Platform
  now?: () => number
  runHostGit?: (cwd: string, args: string[]) => Promise<HostGitResult>
  runWsl?: (spec: WslSpec) => Promise<WslResult>
  checkoutIdentity?: (cwd: string) => Promise<string | null>
  admit?: typeof acquireGitAdmission
}

type ProbeOptions = { cwd: string; wslDistro: string; tier?: GitAdmissionTier }
type Stage = 'host' | 'sample'

const pending = new Map<string, Promise<void>>()
const failures = new Map<string, { count: number; retryAfter: number }>()

function isNotARepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr)
}

async function defaultRunHostGit(cwd: string, args: string[]): Promise<HostGitResult> {
  const env = nonInteractiveGitEnv(process.env)
  const result = await runProcess({
    program: resolveSelectedLocalCommand('git', { env, cwd }),
    args: ['-C', cwd, ...args],
    env,
    timeoutMs: HOST_PROBE_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  })
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  }
}

/** Changes when the checkout is deleted and re-cloned at the same path. */
async function defaultCheckoutIdentity(cwd: string): Promise<string | null> {
  try {
    const marker = await stat(win32.join(cwd, '.git'), { bigint: true })
    return `${marker.ino}:${marker.birthtimeNs}`
  } catch {
    return null
  }
}

function rememberFailure(key: string, now: number): void {
  const count = (failures.get(key)?.count ?? 0) + 1
  failures.set(key, {
    count,
    retryAfter: now + Math.min(RETRY_BASE_MS * 2 ** (count - 1), RETRY_MAX_MS)
  })
}

async function admitted<T>(
  deps: WslWindowsCheckoutProbeDeps,
  request: { args: string[]; cwd: string; wslDistro?: string; tier?: GitAdmissionTier },
  work: () => Promise<T>
): Promise<T> {
  // Why: hundreds of cold worktrees must queue behind the git scheduler, not spawn at once.
  const grant = await (deps.admit ?? acquireGitAdmission)(request)
  try {
    return await work()
  } finally {
    grant.release()
  }
}

async function probeHost(
  key: string,
  options: ProbeOptions,
  deps: WslWindowsCheckoutProbeDeps
): Promise<void> {
  const now = deps.now ?? Date.now
  const result = await admitted(
    deps,
    { args: HOST_CONFIG_ARGS, cwd: options.cwd, tier: options.tier },
    () => (deps.runHostGit ?? defaultRunHostGit)(options.cwd, HOST_CONFIG_ARGS)
  ).catch(() => null)
  let answer: HostAutocrlfAnswer | null = null
  if (result && !result.timedOut) {
    // Exit 1 is `--get-regexp` finding no value: autocrlf unset, which is a settled answer.
    if (result.code === 0 || (result.code === 1 && result.stderr.trim() === '')) {
      answer = parseHostAutocrlf(result.stdout)
    } else if (isNotARepository(result.stderr)) {
      answer = 'not-repo'
    }
  }
  if (answer === null) {
    // Why: no host git, dubious ownership, or a timeout is "unknown", never "not Windows".
    rememberFailure(`host\0${key}`, now())
    return
  }
  failures.delete(`host\0${key}`)
  recordHostAutocrlf(key, answer, now())
}

async function probeSample(
  key: string,
  options: ProbeOptions,
  deps: WslWindowsCheckoutProbeDeps
): Promise<void> {
  const now = deps.now ?? Date.now
  const identity = await (deps.checkoutIdentity ?? defaultCheckoutIdentity)(options.cwd)
  const result = await admitted(
    deps,
    {
      args: ['ls-files', '--eol'],
      cwd: options.cwd,
      wslDistro: options.wslDistro,
      tier: options.tier
    },
    () =>
      (deps.runWsl ?? runWslProcess)({
        distro: options.wslDistro,
        script: SAMPLE_SCRIPT,
        args: [
          translateArgForWsl(options.cwd),
          String(LINE_ENDING_SAMPLE_LIMIT),
          String(LINE_ENDING_SCAN_LIMIT)
        ],
        loginPath: 'preferred',
        timeoutMs: SAMPLE_PROBE_TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024
      })
  ).catch(() => null)
  let answer: LineEndingSampleAnswer | null = null
  if (result && !result.timedOut) {
    if (result.code === 0) {
      answer = classifyLineEndingSample(result.stdout, result.outputTruncated === true)
    } else if (result.code === 3 && isNotARepository(result.stderr)) {
      answer = 'not-windows'
    }
  }
  if (answer === null) {
    rememberFailure(`sample\0${key}`, now())
    return
  }
  failures.delete(`sample\0${key}`)
  recordLineEndingSample(key, answer, identity, now())
}

function runStage(
  stage: Stage,
  key: string,
  options: ProbeOptions,
  deps: WslWindowsCheckoutProbeDeps
): Promise<void> | null {
  const pendingKey = `${stage}\0${key}`
  const running = pending.get(pendingKey)
  if (running) {
    return running
  }
  const failure = failures.get(pendingKey)
  if (failure && failure.retryAfter > (deps.now ?? Date.now)()) {
    return null
  }
  const started = (stage === 'host' ? probeHost : probeSample)(key, options, deps).finally(() =>
    pending.delete(pendingKey)
  )
  pending.set(pendingKey, started)
  return started
}

function waitUnlessAborted(
  work: Promise<void> | null,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!work || !signal) {
    return work ?? Promise.resolve()
  }
  // Why: an aborted command stops waiting; the shared probe keeps running for the next caller.
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', done, { once: true })
    void work.then(done)
  })
}

async function settle(
  args: readonly string[],
  key: string,
  options: ProbeOptions,
  signal: AbortSignal | undefined,
  deps: WslWindowsCheckoutProbeDeps
): Promise<void> {
  const now = deps.now ?? Date.now
  const isRead = isWslDirectGitReadCommand(args)
  if (!isRead && writesAnotherCheckout(args)) {
    return
  }
  let state = getWslWindowsCheckoutState(key)
  if (!state?.host || (!isRead && !isFresh(state.host, now()))) {
    await waitUnlessAborted(runStage('host', key, options, deps), signal)
  } else if (!isFresh(state.host, now())) {
    void runStage('host', key, options, deps)
  }
  state = getWslWindowsCheckoutState(key)
  if (state?.host?.value !== 'true') {
    return
  }
  if (isRead) {
    // Reads are already correct with the flags; the sample only has to catch up for later writes.
    if (!isFresh(state.sample, now())) {
      void runStage('sample', key, options, deps)
    }
    return
  }
  const identityOf = deps.checkoutIdentity ?? defaultCheckoutIdentity
  const identity = await identityOf(options.cwd)
  if (state.sample && identity !== state.sample.identity) {
    forgetLineEndingSample(key)
  }
  if (!isFresh(getWslWindowsCheckoutState(key)?.sample, now())) {
    await waitUnlessAborted(runStage('sample', key, options, deps), signal)
    // Why: a joined sample may have started before the checkout was replaced at this path.
    if (getWslWindowsCheckoutState(key)?.sample?.identity !== (await identityOf(options.cwd))) {
      forgetLineEndingSample(key)
    }
  }
}

/**
 * Settles what a WSL git command on a Windows drive needs to know about its checkout, or null when
 * the command is not one. Never rejects; an unknown answer runs the command unflagged.
 */
export function pendingWslWindowsCheckoutGitConfig(
  args: readonly string[],
  options: {
    cwd: string
    wslDistro?: string
    signal?: AbortSignal
    admissionTier?: GitAdmissionTier
  },
  deps: WslWindowsCheckoutProbeDeps = {}
): Promise<void> | null {
  const { cwd, wslDistro } = options
  if (
    !isWslWindowsCheckoutCandidate(cwd, wslDistro, deps.platform ?? process.platform) ||
    !wslDistro
  ) {
    return null
  }
  return settle(
    args,
    wslWindowsCheckoutKey(cwd, wslDistro),
    { cwd, wslDistro, tier: options.admissionTier },
    options.signal,
    deps
  )
}

export function resetWslWindowsCheckoutProbesForTests(): void {
  pending.clear()
  failures.clear()
}
