import { spawn, type ChildProcess } from 'node:child_process'
import type { ClientChannel } from 'ssh2'
import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../shared/automation-precheck'
import { getSshConnectionManager } from '../ipc/ssh'
import { shellEscape } from '../ssh/ssh-connection-utils'

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

function failedPrecheckResult(
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

function killLocalPrecheckProcessTree(child: ChildProcess): ReturnType<typeof setTimeout> | null {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return null
  }

  if (process.platform === 'win32') {
    try {
      // Why: shell prechecks can launch child processes; taskkill walks the
      // Windows process tree so timeout means the command is actually stopped.
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
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
      /* process group already exited */
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
    let stdout: TailBuffer = { content: '', truncated: false }
    let stderr: TailBuffer = { content: '', truncated: false }
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
        createPrecheckResult({ precheck, startedAt, stdout, stderr, exitCode, timedOut, error })
      )
    }

    timeout = setTimeout(() => {
      timedOut = true
      forceKillTimer = killLocalPrecheckProcessTree(child)
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendTail(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendTail(stderr, chunk)
    })
    child.on('error', (error) => {
      settle(null, error.message)
    })
    child.on('close', (code) => {
      settle(
        typeof code === 'number' ? code : null,
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
    const remoteCommand = `cd ${shellEscape(target.cwd)} && ${precheck.command}`
    const channel = await connection.exec(remoteCommand)
    return await runSshChannelPrecheck({ precheck, channel, startedAt })
  } catch (error) {
    return failedPrecheckResult(
      precheck,
      startedAt,
      error instanceof Error ? error.message : String(error)
    )
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
