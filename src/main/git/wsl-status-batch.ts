import { randomBytes } from 'node:crypto'
import { escapeWslShCommandForWindows, quotePosixShell } from '../../shared/wsl-login-shell-command'
import { withGitSpan } from '../observability/instrumentation'
import {
  DEFAULT_GIT_MAX_BUFFER,
  commandExecFileAsync,
  gitExecFileAsync,
  nonInteractiveGitEnv
} from './runner'
import { isMaxBufferOverflowError } from './max-buffer-overflow'
import { invalidateWslStatusEnvironment, type WslStatusEnvironment } from './wsl-status-environment'
import {
  cachedGitVerificationCommand,
  gitStatusExecFileAsync,
  isCachedGitUnavailable,
  readWslStatusEnvironment,
  resolveWslStatusTarget,
  runWslStatusLoginShellGit,
  translateWslStatusArg,
  wslStatusEnvironmentAssignments,
  type WslStatusGitOptions,
  type WslStatusTarget
} from './wsl-status-runner'

type GitResult = { stdout: string; stderr: string }
type BatchFrame = { output: string; exitCode: number }

const MAX_BATCH_UNSAFE_WORKTREES = 128
const batchUnsafeWorktrees = new Map<string, true>()

function batchWorktreeKey(target: WslStatusTarget): string {
  return `${target.distro}\0${target.linuxCwd}`
}

function isBatchUnsafe(target: WslStatusTarget): boolean {
  const key = batchWorktreeKey(target)
  if (!batchUnsafeWorktrees.delete(key)) {
    return false
  }
  batchUnsafeWorktrees.set(key, true)
  return true
}

function markBatchUnsafe(target: WslStatusTarget): void {
  const key = batchWorktreeKey(target)
  batchUnsafeWorktrees.delete(key)
  batchUnsafeWorktrees.set(key, true)
  if (batchUnsafeWorktrees.size > MAX_BATCH_UNSAFE_WORKTREES) {
    batchUnsafeWorktrees.delete(batchUnsafeWorktrees.keys().next().value!)
  }
}

async function runSeparately(
  commands: string[][],
  options: WslStatusGitOptions,
  run: (args: string[]) => Promise<GitResult>
): Promise<(GitResult | null)[]> {
  return Promise.all(
    commands.map(async (args) => {
      try {
        return await run(args)
      } catch (error) {
        if (options.signal?.aborted) {
          throw error
        }
        return null
      }
    })
  )
}

function batchMarkerPrefix(token: string, index: number): string {
  return `\0\0${token}:${index}:rc=`
}

function batchFramingHeadroom(token: string, commandCount: number): number {
  let bytes = 0
  for (let index = 0; index < commandCount; index += 1) {
    // Shell exit statuses are 0..255; include the trailing NUL as well.
    bytes += Buffer.byteLength(`${batchMarkerPrefix(token, index)}255\0`)
  }
  return bytes
}

export function parseWslStatusBatchOutput(
  stdout: string,
  token: string,
  commandCount: number
): BatchFrame[] | null {
  const frames: BatchFrame[] = []
  let cursor = 0
  for (let index = 0; index < commandCount; index += 1) {
    const prefix = batchMarkerPrefix(token, index)
    const markerIndex = stdout.indexOf(prefix, cursor)
    if (markerIndex < 0) {
      return null
    }
    const codeStart = markerIndex + prefix.length
    const codeEnd = stdout.indexOf('\0', codeStart)
    const codeText = codeEnd < 0 ? '' : stdout.slice(codeStart, codeEnd)
    if (!/^(?:0|[1-9]\d{0,2})$/.test(codeText)) {
      return null
    }
    frames.push({ output: stdout.slice(cursor, markerIndex), exitCode: Number(codeText) })
    cursor = codeEnd + 1
  }
  return cursor === stdout.length ? frames : null
}

function buildBatchCommand(
  target: WslStatusTarget,
  environment: WslStatusEnvironment,
  commands: string[][],
  spawnEnv: NodeJS.ProcessEnv,
  token: string
): string {
  const prefix = [
    '/usr/bin/env',
    ...wslStatusEnvironmentAssignments(spawnEnv, environment.path),
    environment.gitPath
  ]
    .map(quotePosixShell)
    .join(' ')
  const framedCommands = commands.map((args, index) => {
    const command = `${prefix} ${args.map(translateWslStatusArg).map(quotePosixShell).join(' ')}`
    const marker = `${token}:${index}:rc=`
    // Why: numstat -z cannot contain a double-NUL field boundary, so this
    // frame is collision-proof even when a repository controls path names.
    // Why: Git warnings are text, so a random NUL-prefixed boundary preserves
    // per-command stderr without rerunning warned-about commands.
    const frame = `printf '\\000\\000%s%s\\000' ${quotePosixShell(marker)} "$_orca_rc"`
    return `{ ${command}; _orca_rc=$?; ${frame}; ${frame} >&2; }`
  })
  return [
    `cd ${quotePosixShell(target.linuxCwd)} || exit $?`,
    cachedGitVerificationCommand(environment.gitPath),
    ...framedCommands
  ].join('; ')
}

function batchWslArgs(
  target: WslStatusTarget,
  environment: WslStatusEnvironment,
  commands: string[][],
  spawnEnv: NodeJS.ProcessEnv,
  token: string
): string[] {
  const command = buildBatchCommand(target, environment, commands, spawnEnv, token)
  return [
    '-d',
    target.distro,
    '--',
    '/bin/sh',
    '-c',
    escapeWslShCommandForWindows(command),
    'orca:git diff'
  ]
}

function cachedLaunchFailed(
  frames: BatchFrame[],
  stderr: string,
  environment: WslStatusEnvironment
): boolean {
  if (!frames.every(({ exitCode }) => exitCode === 126 || exitCode === 127)) {
    return false
  }
  const error = Object.assign(new Error(stderr), { code: frames[0].exitCode, stderr })
  return isCachedGitUnavailable(error, environment.gitPath)
}

export async function gitStatusExecBatchAsync(
  commands: string[][],
  options: WslStatusGitOptions
): Promise<(GitResult | null)[]> {
  const target = resolveWslStatusTarget(options)
  if (!target) {
    return runSeparately(commands, options, (args) => gitExecFileAsync(args, options))
  }
  if (commands.length < 2) {
    return runSeparately(commands, options, (args) => gitStatusExecFileAsync(args, options))
  }
  return withGitSpan({ args: commands[0], cwd: options.cwd }, async () => {
    const spawnEnv = nonInteractiveGitEnv(options.env)
    const cachedSeparateFallback = (): Promise<(GitResult | null)[]> =>
      runSeparately(commands, options, (args) => gitStatusExecFileAsync(args, options))
    const loginShellFallback = (): Promise<(GitResult | null)[]> =>
      runSeparately(commands, options, (args) =>
        runWslStatusLoginShellGit(target, args, options, spawnEnv)
      )
    if (isBatchUnsafe(target)) {
      return cachedSeparateFallback()
    }
    const environment = await readWslStatusEnvironment(target, options.signal)
    if (!environment) {
      return loginShellFallback()
    }
    const token = `orca-status-batch-${randomBytes(16).toString('hex')}`
    const perCommandMaxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER
    let result: GitResult
    try {
      result = await commandExecFileAsync(
        'wsl.exe',
        batchWslArgs(target, environment, commands, spawnEnv, token),
        {
          env: spawnEnv,
          encoding: 'latin1',
          maxBuffer:
            perCommandMaxBuffer * commands.length + batchFramingHeadroom(token, commands.length),
          signal: options.signal,
          timeout: options.timeout
        }
      )
    } catch (error) {
      if (options.signal?.aborted) {
        throw error
      }
      if (isCachedGitUnavailable(error, environment.gitPath)) {
        invalidateWslStatusEnvironment(target.distro, environment)
        return loginShellFallback()
      }
      if (isMaxBufferOverflowError(error)) {
        markBatchUnsafe(target)
        return cachedSeparateFallback()
      }
      return commands.map(() => null)
    }
    const frames = parseWslStatusBatchOutput(result.stdout, token, commands.length)
    const stderrFrames = parseWslStatusBatchOutput(result.stderr, token, commands.length)
    if (
      !frames ||
      !stderrFrames ||
      frames.some(({ exitCode }, index) => exitCode !== stderrFrames[index].exitCode)
    ) {
      markBatchUnsafe(target)
      return cachedSeparateFallback()
    }
    const decode = (output: string): string => Buffer.from(output, 'latin1').toString('utf8')
    const decodedStderr = stderrFrames.map(({ output }) => decode(output)).join('\n')
    if (cachedLaunchFailed(frames, decodedStderr, environment)) {
      invalidateWslStatusEnvironment(target.distro, environment)
      return loginShellFallback()
    }
    return frames.map(({ output, exitCode }, index) => {
      const stderr = stderrFrames[index].output
      // Why: batching must preserve the old independent maxBuffer contract;
      // one oversized area should not consume the other area's allowance.
      if (
        exitCode !== 0 ||
        Buffer.byteLength(output, 'latin1') > perCommandMaxBuffer ||
        Buffer.byteLength(stderr, 'latin1') > perCommandMaxBuffer
      ) {
        return null
      }
      return { stdout: decode(output), stderr: decode(stderr) }
    })
  })
}

export function clearWslStatusBatchUnsafeCacheForTests(): void {
  batchUnsafeWorktrees.clear()
}
