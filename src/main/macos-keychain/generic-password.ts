// Why execFile and not runProcess: Claude's credential path and its tests read
// execFile's error shape; migrating is a separate change. See the child_process
// import allowlist.
import { execFile } from 'node:child_process'
import {
  armChildExitDeadline,
  type ChildExitDeadline
} from '../../shared/child-process/child-exit-deadline'

const KEYCHAIN_COMMAND_TIMEOUT_MS = 3_000
const REDACTED_SECRET = '<redacted>'
// Fields where Node's child_process errors echo the argv.
const ARGV_BEARING_ERROR_FIELDS = ['message', 'stack', 'cmd', 'spawnargs', 'stdout', 'stderr']

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

// Why: execFile errors embed the full argv, so a failed write would carry the
// `-w <secret>` value into logs and the spawn-error toast.
function redactSecretArgument(error: unknown, args: string[]): unknown {
  const flagIndex = args.indexOf('-w')
  const secret = flagIndex === -1 ? undefined : args[flagIndex + 1]
  if (!secret || !error || typeof error !== 'object') {
    return error
  }
  const redact = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replaceAll(secret, REDACTED_SECRET)
      : Array.isArray(value)
        ? value.map(redact)
        : value
  for (const field of ARGV_BEARING_ERROR_FIELDS) {
    if (field in error) {
      Reflect.set(error, field, redact(Reflect.get(error, field)))
    }
  }
  return error
}

export function execSecurityCommand(args: string[]): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let deadline: ChildExitDeadline | undefined
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      deadline?.clear()
      callback()
    }

    try {
      // Why no execFile `timeout`: it fires from the same late timer and, for a
      // child that already exited, destroys the unread stdout and reports success.
      const child = execFile('security', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          settle(() =>
            reject(
              redactSecretArgument(
                Object.assign(error, {
                  stdout: String(stdout),
                  stderr: String(stderr)
                }),
                args
              )
            )
          )
          return
        }
        settle(() => resolve({ stdout: String(stdout), stderr: String(stderr) }))
      })
      if (settled) {
        return
      }
      // Why a deadline besides the kill: a stuck callback would otherwise leave
      // auth/keychain operations pending.
      deadline = armChildExitDeadline(child, KEYCHAIN_COMMAND_TIMEOUT_MS, () =>
        settle(() => {
          child.kill()
          reject(
            Object.assign(new Error(`security timed out after ${KEYCHAIN_COMMAND_TIMEOUT_MS}ms`), {
              code: 'ETIMEDOUT',
              stderr: ''
            })
          )
        })
      )
    } catch (error) {
      settle(() => reject(redactSecretArgument(error, args)))
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
