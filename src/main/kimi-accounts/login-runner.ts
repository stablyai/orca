import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { getSpawnArgsForWindows } from '../win32-utils'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
export const KIMI_LOGIN_EXIT_WAIT_MS = 3_000
export const KIMI_LOGIN_FORCE_KILL_WAIT_MS = 2_000
const MAX_LOGIN_OUTPUT_CHARS = 8_000
const MAX_INSTRUCTION_CHARS = 1_200
const URL_PATTERN = /https:\/\/[^\s<>"']+/i
const USER_CODE_PATTERN = /\b(?:user\s+)?code\s*[:=]\s*[A-Z0-9-]{4,}\b/i
const SENSITIVE_LINE_PATTERN =
  /access[_ -]?token|refresh[_ -]?token|authorization:\s*bearer|\bbearer\s+\S+/i
const INSTRUCTION_LINE_PATTERN = /https:\/\/|\b(code|visit|open|browser|authoriz)\w*\b/i

export type KimiLoginInstructions = {
  verificationUrl: string | null
  message: string
}

export type KimiLoginInstructionHandler = (
  instructions: KimiLoginInstructions
) => Promise<'continue' | 'cancel'>

export function retainRecentLoginOutput(output: string): string {
  if (output.length <= MAX_LOGIN_OUTPUT_CHARS) {
    return output
  }
  const sliced = output.slice(-MAX_LOGIN_OUTPUT_CHARS)
  const newline = sliced.indexOf('\n')
  // Why: a byte cut can land inside the managed-home path; drop that partial line
  // so later redaction still matches complete remaining lines.
  return newline === -1 ? '' : sliced.slice(newline + 1)
}

export function parseKimiLoginInstructions(
  output: string,
  managedHomePath: string
): KimiLoginInstructions | null {
  const lines = stripAnsiEscapeSequences(output)
    .replaceAll(managedHomePath, '[managed home]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.includes('[managed home]') &&
        INSTRUCTION_LINE_PATTERN.test(line) &&
        !SENSITIVE_LINE_PATTERN.test(line)
    )
  const message = lines.join('\n').slice(0, MAX_INSTRUCTION_CHARS)
  if (!message) {
    return null
  }
  const verificationUrl = message.match(URL_PATTERN)?.[0] ?? null
  if (
    !verificationUrl ||
    (!USER_CODE_PATTERN.test(message) && !/[?&]user_code=/i.test(verificationUrl))
  ) {
    return null
  }
  return { verificationUrl, message }
}

function signalLoginProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    }).once('error', () => child.kill(signal))
    return
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the direct child when a process group is unavailable.
    }
  }
  child.kill(signal)
}

function terminateLogin(child: ChildProcess): void {
  signalLoginProcess(child, 'SIGTERM')
}

function forceKillLogin(child: ChildProcess): void {
  signalLoginProcess(child, 'SIGKILL')
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

export function runKimiLogin(
  managedHomePath: string,
  onInstructions: KimiLoginInstructionHandler
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = resolveCliCommand('kimi')
    const invocation = getSpawnArgsForWindows(command, ['login'])
    const child = spawn(invocation.spawnCmd, invocation.spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, KIMI_CODE_HOME: managedHomePath }
    })
    let settled = false
    let prompted = false
    let pendingError: Error | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    let abandonTimer: ReturnType<typeof setTimeout> | null = null
    let output = ''
    const stdout = child.stdout
    const stderr = child.stderr
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')

    const cleanup = (): void => {
      clearTimeout(timeout)
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      if (abandonTimer) {
        clearTimeout(abandonTimer)
      }
      stdout?.off('data', onStdout)
      stderr?.off('data', onStderr)
      child.off('error', onError)
      child.off('close', onClose)
    }
    const settle = (complete: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      complete()
    }
    const rejectAfterExit = (error: Error): void => {
      if (settled) {
        return
      }
      pendingError = error
      terminateLogin(child)
      if (hasExited(child)) {
        settle(() => reject(error))
        return
      }
      forceKillTimer = setTimeout(() => {
        if (settled) {
          return
        }
        forceKillLogin(child)
        abandonTimer = setTimeout(() => {
          settle(() => reject(pendingError ?? error))
        }, KIMI_LOGIN_FORCE_KILL_WAIT_MS)
      }, KIMI_LOGIN_EXIT_WAIT_MS)
    }
    const timeout = setTimeout(() => {
      rejectAfterExit(new Error('Kimi sign-in took too long to finish.'))
    }, LOGIN_TIMEOUT_MS)
    const consumeDecoded = (text: string): void => {
      output = retainRecentLoginOutput(`${output}${text}`)
      if (prompted) {
        return
      }
      const instructions = parseKimiLoginInstructions(output, managedHomePath)
      if (!instructions) {
        return
      }
      prompted = true
      void onInstructions(instructions).then(
        (decision) => {
          if (decision === 'cancel' && !settled) {
            rejectAfterExit(new Error('Kimi sign-in was cancelled.'))
          }
        },
        () => {
          if (!settled) {
            rejectAfterExit(new Error('Kimi sign-in prompt could not be shown.'))
          }
        }
      )
    }
    const onStdout = (chunk: Buffer): void => {
      consumeDecoded(stdoutDecoder.write(chunk))
    }
    const onStderr = (chunk: Buffer): void => {
      consumeDecoded(stderrDecoder.write(chunk))
    }
    const onError = (error: NodeJS.ErrnoException): void => {
      settle(() =>
        reject(
          new Error(
            error.code === 'ENOENT'
              ? 'Kimi Code CLI was not found.'
              : 'Kimi sign-in could not be started.'
          )
        )
      )
    }
    const onClose = (code: number | null): void => {
      if (pendingError) {
        settle(() => reject(pendingError))
        return
      }
      settle(() => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error('Kimi sign-in did not complete. Please try again.'))
        }
      })
    }

    child.once('error', onError)
    child.once('close', onClose)
    if (!stdout || !stderr) {
      rejectAfterExit(new Error('Kimi sign-in could not open its output streams.'))
      return
    }
    stdout.on('data', onStdout)
    stderr.on('data', onStderr)
  })
}
