import { runProcess, type ProcessResult } from '../shared/child-process/run-process'
import {
  expandFormatOnSaveCommand,
  type FormatOnSaveResult
} from '../shared/format-on-save-command'
import { getCmdExePath } from '../shared/windows-batch-spawn'
import { parseWslPath, toLinuxPath } from './wsl'
import { runWslProcess } from './wsl/wsl-runner'
import { FORMAT_ON_SAVE_TIMEOUT_MS } from './format-on-save-timeout'

// Why: a chatty-but-successful formatter (`black --verbose`, `prettier
// --loglevel debug`) must not be reported as a failure just for talking. Output
// is only read to explain a non-zero exit, so past this cap it is clipped
// rather than turned into an error.
const FORMAT_ON_SAVE_OUTPUT_CAP_BYTES = 1024 * 1024

export type FormatCommandExecution = {
  command: string
  worktreePath: string
  absoluteFilePath: string
  relativePath: string
}

type FormatterExit = Pick<ProcessResult, 'code' | 'stdout' | 'stderr' | 'timedOut'> & {
  signal?: NodeJS.Signals | null
}

export async function executeFormatCommand({
  command,
  worktreePath,
  absoluteFilePath,
  relativePath
}: FormatCommandExecution): Promise<FormatOnSaveResult> {
  const wslInfo = parseWslPath(worktreePath)

  try {
    if (wslInfo) {
      // Why: the worktree lives on the WSL filesystem, so the formatter and the
      // paths it receives must both be Linux-side; a Windows-native run would
      // either miss the toolchain or crawl over the 9P bridge.
      const script = expandFormatOnSaveCommand({
        command,
        absolutePath: toLinuxPath(absoluteFilePath),
        relativePath,
        platform: 'linux'
      })
      // Why: killing wsl.exe on timeout does not guarantee the guest formatter dies with it.
      return toFormatResult(
        await runWslProcess({
          distro: wslInfo.distro ?? undefined,
          script,
          shell: 'bash',
          cwd: wslInfo.linuxPath,
          loginPath: 'preferred',
          timeoutMs: FORMAT_ON_SAVE_TIMEOUT_MS,
          maxOutputBytes: FORMAT_ON_SAVE_OUTPUT_CAP_BYTES
        })
      )
    }

    const isWindows = process.platform === 'win32'
    const expanded = expandFormatOnSaveCommand({
      command,
      absolutePath: absoluteFilePath,
      relativePath,
      platform: process.platform
    })
    return toFormatResult(
      await runProcess({
        program: isWindows ? getCmdExePath() : '/bin/bash',
        // Why: `/s` strips exactly the outer quotes, so the command line is handed
        // over verbatim; Node's default argv quoting would escape the inner
        // quotes as `\"`, which cmd.exe does not understand.
        args: isWindows ? ['/d', '/s', '/c', `"${expanded}"`] : ['-c', expanded],
        windowsVerbatimArguments: isWindows,
        cwd: worktreePath,
        timeoutMs: FORMAT_ON_SAVE_TIMEOUT_MS,
        maxOutputBytes: FORMAT_ON_SAVE_OUTPUT_CAP_BYTES,
        // Why: the shell alone would die on timeout while a formatter it started
        // (`npx prettier`) kept running and rewrote the file over a later save.
        // The barrier kills the whole tree and settles only once it is gone, so
        // the caller's in-flight slot is never released with an orphan alive.
        terminationBarrier: true
      })
    )
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

function toFormatResult({
  code,
  signal,
  stdout,
  stderr,
  timedOut
}: FormatterExit): FormatOnSaveResult {
  // Why: a killed formatter has no exit code and usually no stderr — name the
  // timeout so the user looks at the command rather than at their file.
  if (timedOut) {
    return {
      status: 'failed',
      message: `Formatter timed out after ${FORMAT_ON_SAVE_TIMEOUT_MS}ms.`
    }
  }
  if (code === 0) {
    return { status: 'completed' }
  }

  // Why: formatters put the actionable parse error on stderr and exit non-zero.
  const output = [stderr.trim(), stdout.trim()].find((candidate) => candidate.length > 0)
  if (output) {
    return { status: 'failed', message: output }
  }
  return {
    status: 'failed',
    message:
      code === null
        ? `Formatter was stopped by ${signal ?? 'a signal'}.`
        : `Formatter exited with code ${code}.`
  }
}
