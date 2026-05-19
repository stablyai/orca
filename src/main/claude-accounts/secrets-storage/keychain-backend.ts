import { execFile } from 'node:child_process'
import type { SecretsStorage } from './types'

// Wraps the macOS `security` CLI as a SecretsStorage backend. Mirrors the
// existing keychain.ts shape so the LRU cache + callers can swap to the
// abstraction without changing behavior on macOS.
export function createKeychainBackend(): SecretsStorage {
  return {
    backendId: 'keychain',
    read: (service, account) => readKeychainPassword(service, account),
    write: (service, account, value) => writeKeychainPassword(service, account, value),
    delete: (service, account) => deleteKeychainPassword(service, account)
  }
}

async function readKeychainPassword(service: string, account: string): Promise<string | null> {
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
        // `security` exits 44 with "could not be found" for missing items —
        // surface that as a null read, not an error.
        if (
          code === 44 ||
          message.includes('could not be found') ||
          message.includes('not be found')
        ) {
          resolve(null)
          return
        }
        reject(error ?? new Error(`Could not read keychain item ${service}/${account}.`))
      }
    )
  })
}

async function writeKeychainPassword(
  service: string,
  account: string,
  contents: string
): Promise<void> {
  // -U upserts: replace the existing entry if present, create otherwise.
  await execSecurity(['add-generic-password', '-U', '-s', service, '-a', account, '-w', contents])
}

async function deleteKeychainPassword(service: string, account: string): Promise<void> {
  await execSecurity(['delete-generic-password', '-s', service, '-a', account], {
    ignoreNotFound: true,
    ignoreFailure: true
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
