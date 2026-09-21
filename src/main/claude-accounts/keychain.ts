import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'

const ACTIVE_CLAUDE_SERVICE = 'Claude Code-credentials'
const ORCA_CLAUDE_SERVICE = 'Orca Claude Code Managed Credentials'
const KEYCHAIN_COMMAND_TIMEOUT_MS = 3_000

type SecurityCommandResult = {
  stdout: string
  stderr: string
}

export async function readActiveClaudeKeychainCredentials(
  configDir?: string
): Promise<string | null> {
  for (const service of getActiveClaudeServices(configDir)) {
    const credentials = await readKeychainPassword(service, getKeychainUser())
    if (credentials) {
      return credentials
    }
  }
  return null
}

export async function readActiveClaudeKeychainCredentialsStrict(
  configDir?: string
): Promise<string | null> {
  if (!configDir) {
    return readKeychainPassword(getActiveClaudeService(), getKeychainUser())
  }
  // Why: macOS tmp is /var → /private/var. Claude hashes the realpath; a
  // mkdtemp login dir would miss the Keychain item if we only hashed the raw path.
  for (const dir of claudeConfigDirKeychainAliases(configDir)) {
    const credentials = await readKeychainPassword(getActiveClaudeService(dir), getKeychainUser())
    if (credentials) {
      return credentials
    }
  }
  return null
}

export async function writeActiveClaudeKeychainCredentials(
  contents: string,
  configDir?: string
): Promise<void> {
  await writeKeychainPassword(getActiveClaudeService(configDir), getKeychainUser(), contents)
}

export async function writeActiveClaudeKeychainCredentialsForRuntime(
  contents: string,
  configDir: string
): Promise<void> {
  const user = getKeychainUser()
  const scopedService = getActiveClaudeService(configDir)
  await writeKeychainPassword(scopedService, user, contents)
  if (scopedService !== ACTIVE_CLAUDE_SERVICE) {
    await writeKeychainPassword(ACTIVE_CLAUDE_SERVICE, user, contents)
  }
}

export async function deleteActiveClaudeKeychainCredentials(configDir?: string): Promise<void> {
  for (const service of getActiveClaudeServices(configDir)) {
    for (const account of getKeychainUsersForCleanup()) {
      await deleteKeychainPassword(service, account)
    }
  }
}

export async function deleteActiveClaudeKeychainCredentialsStrict(
  configDir?: string
): Promise<void> {
  const dirs = configDir ? claudeConfigDirKeychainAliases(configDir) : [undefined]
  for (const dir of dirs) {
    for (const account of getKeychainUsersForCleanup()) {
      await deleteKeychainPassword(getActiveClaudeService(dir), account, {
        failOnAccessError: true
      })
    }
  }
}

export async function readManagedClaudeKeychainCredentials(
  accountId: string
): Promise<string | null> {
  return readKeychainPassword(ORCA_CLAUDE_SERVICE, accountId)
}

export async function writeManagedClaudeKeychainCredentials(
  accountId: string,
  contents: string
): Promise<void> {
  await writeKeychainPassword(ORCA_CLAUDE_SERVICE, accountId, contents)
}

export async function deleteManagedClaudeKeychainCredentials(accountId: string): Promise<void> {
  await deleteKeychainPassword(ORCA_CLAUDE_SERVICE, accountId)
}

const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/
const CLAUDE_CODE_FALLBACK_USER = 'claude-code-user'

function getKeychainUser(): string {
  // Why: Claude Code 2.1+ rejects $USER outside [a-zA-Z0-9._-] (SSO names like
  // first@example.com) and stores the item under claude-code-user (#12857).
  let user: string
  try {
    user = process.env.USER || process.env.USERNAME || userInfo().username
  } catch {
    return CLAUDE_CODE_FALLBACK_USER
  }
  return KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : CLAUDE_CODE_FALLBACK_USER
}

function getKeychainUsersForCleanup(): string[] {
  const derived = getKeychainUser()
  const raw = process.env.USER || process.env.USERNAME
  return raw && raw !== derived ? [derived, raw] : [derived]
}

function getActiveClaudeService(configDir?: string): string {
  if (!configDir) {
    return ACTIVE_CLAUDE_SERVICE
  }
  // Why: Claude Code 2.1+ scopes macOS Keychain credentials by config dir
  // using the first 8 hex chars of sha256(NFC(CLAUDE_CONFIG_DIR)).
  const suffix = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
  return `${ACTIVE_CLAUDE_SERVICE}-${suffix}`
}

export function claudeConfigDirKeychainAliases(configDir: string): string[] {
  const aliases = [configDir]
  try {
    const canonical = realpathSync(configDir)
    if (canonical !== configDir) {
      aliases.push(canonical)
    }
  } catch {
    // Login temp dirs can vanish before capture; keep the raw path.
  }
  return aliases
}

function getActiveClaudeServices(configDir?: string): string[] {
  if (!configDir) {
    return [ACTIVE_CLAUDE_SERVICE]
  }
  const scoped = claudeConfigDirKeychainAliases(configDir).map((dir) => getActiveClaudeService(dir))
  return [...new Set([...scoped, ACTIVE_CLAUDE_SERVICE])]
}

async function readKeychainPassword(service: string, account: string): Promise<string | null> {
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

async function writeKeychainPassword(
  service: string,
  account: string,
  contents: string
): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  await execSecurity(['add-generic-password', '-U', '-s', service, '-a', account, '-w', contents])
}

async function deleteKeychainPassword(
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

function execSecurity(
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

function isKeychainNotFoundError(error: unknown): boolean {
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

function execSecurityCommand(args: string[]): Promise<SecurityCommandResult> {
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
