import { randomUUID } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

type DevinLoginCaptureOptions = {
  platform?: NodeJS.Platform
  appDataRoot?: string
}

function fileExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function requireCredentialFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error('Devin login requires a regular credentials.toml smaller than 16 MiB.')
  }
}

function resolveAppDataRoot(appDataRoot?: string): string {
  const appData = appDataRoot ?? process.env.APPDATA?.trim()
  return appData && isAbsolute(appData) ? appData : join(homedir(), 'AppData', 'Roaming')
}

/** Capture Devin's Windows credential file while keeping the prior host login recoverable. */
export async function runDevinLoginWithCredentialCapture(
  dataHome: string,
  login: (extraEnv: Record<string, string>) => Promise<void>,
  options: DevinLoginCaptureOptions = {}
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') {
    await login({})
    return
  }

  const hostCredential = join(resolveAppDataRoot(options.appDataRoot), 'devin', 'credentials.toml')
  const sandboxCredential = join(dataHome, 'devin', 'credentials.toml')
  const backup = `${hostCredential}.orca-account-add-${randomUUID()}.bak`
  const hadHostCredential = fileExists(hostCredential)
  if (hadHostCredential) {
    requireCredentialFile(hostCredential)
    renameSync(hostCredential, backup)
  }

  let loginFailed = false
  let loginError: unknown
  try {
    await login({ APPDATA: dataHome })
    if (!fileExists(sandboxCredential) && fileExists(hostCredential)) {
      requireCredentialFile(hostCredential)
      mkdirSync(dirname(sandboxCredential), { recursive: true, mode: 0o700 })
      copyFileSync(hostCredential, sandboxCredential)
    }
  } catch (error) {
    loginFailed = true
    loginError = error
  }

  try {
    if (hadHostCredential) {
      if (fileExists(hostCredential)) {
        rmSync(hostCredential)
      }
      renameSync(backup, hostCredential)
    } else if (fileExists(hostCredential)) {
      rmSync(hostCredential)
    }
  } catch (restoreError) {
    const message = hadHostCredential
      ? `Devin login could not restore the previous credential; its backup remains at ${backup}.`
      : 'Devin login could not clean up the host credential file.'
    throw loginFailed
      ? new AggregateError([loginError, restoreError], message, { cause: loginError })
      : new Error(message, { cause: restoreError })
  }

  if (loginFailed) {
    throw loginError
  }
}
