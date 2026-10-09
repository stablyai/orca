// Why execFile and not runProcess: this is a relocation of the Claude keychain
// reader's existing exception, kept byte-for-byte so Claude's credential path and
// its tests are unchanged. See the child_process import allowlist.
import { execFile } from 'node:child_process'

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

    // Why: Node's execFile timeout only signals the `security` process; a
    // stuck callback would otherwise leave auth/keychain operations pending.
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

export function execSecurity(
  args: string[],
  options?: { ignoreFailure?: boolean; ignoreNotFound?: boolean }
): Promise<void> {
  return execSecurityCommand(args).then(undefined, (error: unknown) => {
    if (options?.ignoreNotFound && isKeychainNotFoundError(error)) {
      return
    }
    if (!options?.ignoreFailure) {
      throw error
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

export async function writeKeychainPassword(
  service: string,
  account: string,
  contents: string
): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  await execSecurity(['add-generic-password', '-U', '-s', service, '-a', account, '-w', contents])
}

export async function deleteKeychainPassword(
  service: string,
  account: string,
  options?: { failOnAccessError?: boolean }
): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  await execSecurity(['delete-generic-password', '-s', service, '-a', account], {
    ignoreNotFound: true,
    ignoreFailure: !options?.failOnAccessError
  })
}
