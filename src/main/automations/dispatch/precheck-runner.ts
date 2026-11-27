import { spawn, type ChildProcess } from 'node:child_process'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { childProcessHasExited } from '@orca/process-host/process-tree-termination'
import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import type { ClientChannel } from 'ssh2'
import type { AutomationPrecheck } from '../../../shared/automations/automation-definition'
import type { AutomationPrecheckResult } from '../../../shared/automations/history/automation-run'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../../shared/automations/launch/automation-precheck'
import { getSshConnectionManager } from '../../ssh/targets/ssh-target-registry'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { admitSelfInitiatedTreeKill } from '../../pty/process-retirement/own-chromium-tree-kill-guard'
import { errorMessage } from '../../../shared/errors/error-message'
import { decodeWindowsShellOutput } from '../../windows/windows-shell-output-decoding'

type AutomationPrecheckExecutionTarget =
  | {
      type: 'local'
      cwd: string
    }
  | {
      type: 'ssh'
      cwd: string
      connectionId: string
    }

type TailBuffer = {
  content: string
  truncated: boolean
}

function appendTail(buffer: TailBuffer, chunk: string): TailBuffer {
  const content = `${buffer.content}${chunk}`
  if (content.length <= MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS) {
    return { ...buffer, content }
  }
  return {
    content: content.slice(-MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS),
    truncated: true
  }
}

// Four bytes per character keeps enough raw output to fill the character cap after decoding.
const MAX_PRECHECK_OUTPUT_BYTES = MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS * 4

// Decode once at the end so cmd.exe messages can be decoded in its code page.
function decodeByteTail(sink: ReturnType<typeof createOutputSink>): TailBuffer {
  const bytes = sink.buffer()
  const truncated = sink.truncated()
  let start = 0
  // Drop the rest of a UTF-8 character the cut split, or its whole line would fail UTF-8 and decode as OEM.
  while (truncated && start < 3 && (bytes[start] & 0xc0) === 0x80) {
    start++
  }
  return appendTail({ content: '', truncated }, decodeWindowsShellOutput(bytes.subarray(start)))
}

function createPrecheckResult(args: {
  precheck: AutomationPrecheck
  startedAt: number
  stdout: TailBuffer
  stderr: TailBuffer
  exitCode: number | null
  timedOut: boolean
  error: string | null
}): AutomationPrecheckResult {
  const completedAt = Date.now()
  return {
    command: args.precheck.command,
    exitCode: args.exitCode,
    timedOut: args.timedOut,
    durationMs: Math.max(0, completedAt - args.startedAt),
    stdout: args.stdout.content,
    stderr: args.stderr.content,
    stdoutTruncated: args.stdout.truncated,
    stderrTruncated: args.stderr.truncated,
    error: args.error,
    startedAt: args.startedAt,
    completedAt
  }
}

export function failedPrecheckResult(
  precheck: AutomationPrecheck,
  startedAt: number,
  error: string
): AutomationPrecheckResult {
  return createPrecheckResult({
    precheck,
    startedAt,
    stdout: { content: '', truncated: false },
    stderr: { content: '', truncated: false },
    exitCode: null,
    timedOut: false,
    error
  })
}

export function killLocalPrecheckProcessTree(
  child: ChildProcess
): ReturnType<typeof setTimeout> | null {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return null
  }

  if (process.platform === 'win32') {
    // An exited root's pid may be reused before close; only the handle kill is safe then.
    if (
      childProcessHasExited(child) ||
      !admitSelfInitiatedTreeKill({
        pid,
        site: 'automation-precheck-timeout',
        scope: 'win-taskkill-tree'
      })
    ) {
      child.kill()
      return null
    }
    try {
      // Shell prechecks can leave descendants running after the root exits.
      const killer = spawn(
        windowsSystem32Binary('taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'],
        {
          stdio: 'ignore',
          windowsHide: true
        }
      )
      killer.on('error', () => child.kill())
      killer.unref()
    } catch {
      child.kill()
    }
    return null
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill()
  }

  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* Ignore errors from the final best-effort group kill. */
    }
  }, 2000)
  forceKillTimer.unref?.()
  return forceKillTimer
}

function runLocalPrecheck(
  precheck: AutomationPrecheck,
  target: Extract<AutomationPrecheckExecutionTarget, { type: 'local' }>
): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  const timeoutMs = precheck.timeoutSeconds * 1000
  return new Promise((resolve) => {
    const stdout = createOutputSink(MAX_PRECHECK_OUTPUT_BYTES, 'tail')
    const stderr = createOutputSink(MAX_PRECHECK_OUTPUT_BYTES, 'tail')
    let timedOut = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const child = spawn(precheck.command, {
      cwd: target.cwd,
      detached: process.platform !== 'win32',
      env: process.env,
      shell: true,
      windowsHide: true
    })

    const settle = (exitCode: number | null, error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
      resolve(
        createPrecheckResult({
          precheck,
          startedAt,
          stdout: decodeByteTail(stdout),
          stderr: decodeByteTail(stderr),
          exitCode,
          timedOut,
          error
        })
      )
    }

    timeout = setTimeout(() => {
      timedOut = true
      forceKillTimer = killLocalPrecheckProcessTree(child)
    }, timeoutMs)

    child.stdout?.on('data', stdout.write)
    child.stderr?.on('data', stderr.write)
    child.on('error', (error) => {
      settle(null, error.message)
    })
    child.on('close', (code) => {
      settle(
        timedOut || typeof code !== 'number' ? null : code,
        timedOut ? `Precheck timed out after ${precheck.timeoutSeconds}s.` : null
      )
    })
  })
}

function runSshChannelPrecheck(args: {
  precheck: AutomationPrecheck
  channel: ClientChannel
  startedAt: number
}): Promise<AutomationPrecheckResult> {
  const { precheck, channel, startedAt } = args
  const timeoutMs = precheck.timeoutSeconds * 1000
  return new Promise((resolve) => {
    let stdout: TailBuffer = { content: '', truncated: false }
    let stderr: TailBuffer = { content: '', truncated: false }
    let exitCode: number | null = null
    let timedOut = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const settle = (exitCode: number | null, error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      resolve(
        createPrecheckResult({ precheck, startedAt, stdout, stderr, exitCode, timedOut, error })
      )
    }

    timeout = setTimeout(() => {
      timedOut = true
      channel.close()
    }, timeoutMs)

    const fail = (error: Error): void => {
      settle(null, error.message)
    }
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', (data: Buffer | string) => {
      stdout = appendTail(stdout, data.toString())
    })
    channel.stderr.on('data', (data: Buffer | string) => {
      stderr = appendTail(stderr, data.toString())
    })
    channel.on('exit', (code: number | null) => {
      exitCode = typeof code === 'number' ? code : null
    })
    channel.on('close', (code?: number | null) => {
      if (typeof code === 'number') {
        exitCode = code
      }
      settle(exitCode, timedOut ? `Precheck timed out after ${precheck.timeoutSeconds}s.` : null)
    })
  })
}

async function runSshPrecheck(
  precheck: AutomationPrecheck,
  target: Extract<AutomationPrecheckExecutionTarget, { type: 'ssh' }>
): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  const manager = getSshConnectionManager()
  const connection = manager?.getConnection(target.connectionId)
  if (!connection || connection.getState().status !== 'connected') {
    return failedPrecheckResult(precheck, startedAt, 'SSH target is not connected.')
  }
  try {
    const remoteCommand = `cd ${quotePosixShell(target.cwd)} && ${precheck.command}`
    const channel = await connection.execWithClosedStdin(remoteCommand)
    return await runSshChannelPrecheck({ precheck, channel, startedAt })
  } catch (error) {
    return failedPrecheckResult(precheck, startedAt, errorMessage(error))
  }
}

export async function runAutomationPrecheck(args: {
  precheck: AutomationPrecheck
  target: AutomationPrecheckExecutionTarget
}): Promise<AutomationPrecheckResult> {
  if (args.target.type === 'ssh') {
    return await runSshPrecheck(args.precheck, args.target)
  }
  return await runLocalPrecheck(args.precheck, args.target)
}
