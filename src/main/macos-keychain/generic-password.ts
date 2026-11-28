import { execFile } from 'node:child_process'
import { runProcess } from '@orca/process-host'

const KEYCHAIN_COMMAND_TIMEOUT_MS = 3_000

type SecurityCommandResult = {
  stdout: string
  stderr: string
}

export function isKeychainNotFoundError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  const message =
    error && typeof error === 'object'
      ? `${String((error as { stderr?: unknown }).stderr ?? '')} ${String(
          (error as { message?: unknown }).message ?? ''
        )}`.toLowerCase()
      : String(error).toLowerCase()
  return code === 44 || message.includes('could not be found') || message.includes('not be found')
}

export function execSecurityCommand(args: string[]): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      reject(
        Object.assign(new Error(`security timed out after ${KEYCHAIN_COMMAND_TIMEOUT_MS}ms`), {
          code: 'ETIMEDOUT',
          stderr: ''
        })
      )
    }, KEYCHAIN_COMMAND_TIMEOUT_MS)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    // execFile timeout signals the child; the outer timer also settles a callback that never returns.
    try {
      child = execFile(
        'security',
        args,
        { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (error) {
            settle(() =>
              reject(
                Object.assign(error, {
                  stdout: String(stdout),
                  stderr: String(stderr)
                })
              )
            )
            return
          }
          settle(() => resolve({ stdout: String(stdout), stderr: String(stderr) }))
        }
      )
    } catch (error) {
      settle(() => reject(error))
    }
  })
}

export async function readKeychainPassword(
  service: string,
  account: string
): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  try {
    const { stdout } = await execSecurityCommand([
      'find-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w'
    ])
    if (stdout.trim()) {
      return stdout.trim()
    }
    throw new Error(`Could not read macOS Keychain item ${service}/${account}.`)
  } catch (error) {
    if (isKeychainNotFoundError(error)) {
      return null
    }
    throw error
  }
}

// security -i reads one command per line and cuts lines past this length.
const SECURITY_INTERACTIVE_LINE_LIMIT = 4032

function securityTargetIsSafe(...values: string[]): boolean {
  return values.every((value) => value !== '' && !/[\r\n"\\]/.test(value))
}

export function keychainPasswordFitsInteractiveWrite(
  service: string,
  account: string,
  value: string
): boolean {
  return securityWriteLine(service, account, value).length <= SECURITY_INTERACTIVE_LINE_LIMIT
}

function securityWriteLine(service: string, account: string, value: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex')
  return `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`
}

/** Writes through stdin so the value never appears in argv; errors never carry security output. */
export async function writeKeychainPassword(
  service: string,
  account: string,
  value: string
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('The macOS Keychain is unavailable on this host.')
  }
  if (!securityTargetIsSafe(service, account)) {
    throw new Error('The macOS Keychain item name is invalid.')
  }
  const line = securityWriteLine(service, account, value)
  if (line.length > SECURITY_INTERACTIVE_LINE_LIMIT) {
    throw new Error('The value exceeds the macOS Keychain command limit.')
  }
  let ok = false
  try {
    const result = await runProcess({
      program: '/usr/bin/security',
      args: ['-i'],
      input: line,
      timeoutMs: KEYCHAIN_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
    ok = result.code === 0 && !result.timedOut && !result.signal
  } catch {
    ok = false
  }
  if (!ok) {
    throw new Error(`Could not update macOS Keychain item ${service}.`)
  }
}

export async function deleteKeychainPassword(service: string, account: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    await execSecurityCommand(['delete-generic-password', '-s', service, '-a', account])
  } catch (error) {
    if (!isKeychainNotFoundError(error)) {
      throw new Error(`Could not delete macOS Keychain item ${service}.`)
    }
  }
}
