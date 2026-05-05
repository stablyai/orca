import { execFile } from 'node:child_process'

const ACTIVE_CLAUDE_SERVICE = 'Claude Code-credentials'
const ORCA_CLAUDE_SERVICE = 'Orca Claude Code Managed Credentials'

export async function readActiveClaudeKeychainCredentials(): Promise<string | null> {
  return readKeychainPassword(ACTIVE_CLAUDE_SERVICE, getKeychainUser())
}

export async function writeActiveClaudeKeychainCredentials(contents: string): Promise<void> {
  await writeKeychainPassword(ACTIVE_CLAUDE_SERVICE, getKeychainUser(), contents)
}

export async function deleteActiveClaudeKeychainCredentials(): Promise<void> {
  await deleteKeychainPassword(ACTIVE_CLAUDE_SERVICE, getKeychainUser())
}

export async function deleteActiveClaudeKeychainCredentialsStrict(): Promise<void> {
  await deleteKeychainPassword(ACTIVE_CLAUDE_SERVICE, getKeychainUser(), {
    failOnAccessError: true
  })
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

function getKeychainUser(): string {
  return process.env.USER || process.env.USERNAME || 'user'
}

async function readKeychainPassword(service: string, account: string): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: 3_000 },
      (error, stdout, stderr) => {
        if (!error && stdout.trim()) {
          resolve(stdout.trim())
          return
        }
        const message = `${stderr} ${error?.message ?? ''}`.toLowerCase()
        const code = (error as { code?: unknown } | null)?.code
        if (
          code === 44 ||
          message.includes('could not be found') ||
          message.includes('not be found')
        ) {
          resolve(null)
          return
        }
        reject(error ?? new Error(`Could not read macOS Keychain item ${service}/${account}.`))
      }
    )
  })
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
  return new Promise((resolve, reject) => {
    execFile('security', args, { timeout: 3_000 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve()
        return
      }
      const code = (error as { code?: unknown }).code
      const message = `${stderr} ${error.message}`.toLowerCase()
      if (
        options?.ignoreNotFound &&
        (code === 44 || message.includes('could not be found') || message.includes('not be found'))
      ) {
        resolve()
        return
      }
      if (!options?.ignoreFailure) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
