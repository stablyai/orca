import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toWindowsWslPath } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'
import type { CapturedClaudeAuth } from './claude-auth-capture'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import type { ClaudeManagedAuthLocation } from './claude-managed-auth-storage'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials
} from './keychain'

const LOGIN_TIMEOUT_MS = 180_000
const STATUS_TIMEOUT_MS = 20_000

type ClaudeLoginSessionDependencies = {
  runCommand: (
    args: string[],
    config: ClaudeCommandConfig,
    timeoutMs: number,
    options?: ClaudeCommandOptions
  ) => Promise<string>
  capture: (
    configDir: string,
    statusOutput: string,
    previousLegacyKeychain: string | null
  ) => Promise<CapturedClaudeAuth>
  setCancel: (cancel: (() => boolean) | null) => void
}

export async function runClaudeLoginSession(
  location: ClaudeManagedAuthLocation,
  dependencies: ClaudeLoginSessionDependencies
): Promise<CapturedClaudeAuth> {
  const tempConfig = await createTemporaryClaudeConfigDir(location)
  const controller = new AbortController()
  dependencies.setCancel(() => {
    if (controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  })
  const previousLegacyKeychain = await readActiveClaudeKeychainCredentials()
  let captured: CapturedClaudeAuth | null = null
  let captureError: unknown = null
  let cleanupError: unknown = null
  try {
    if (controller.signal.aborted) {
      throw new Error('Claude sign-in was cancelled.')
    }
    await dependencies.runCommand(['auth', 'login', '--claudeai'], tempConfig, LOGIN_TIMEOUT_MS, {
      signal: controller.signal,
      keepStdinOpen: true
    })
    dependencies.setCancel(null)
    const status = await dependencies.runCommand(
      ['auth', 'status', '--json'],
      tempConfig,
      STATUS_TIMEOUT_MS,
      { allowFailure: true }
    )
    captured = await dependencies.capture(tempConfig.windowsPath, status, previousLegacyKeychain)
  } catch (error) {
    captureError = error
  } finally {
    if (process.platform === 'darwin') {
      try {
        await deleteActiveClaudeKeychainCredentialsStrict(tempConfig.windowsPath)
      } catch (error) {
        console.warn('[claude-accounts] Failed to clean temporary Claude Keychain item:', error)
      }
      try {
        await (previousLegacyKeychain
          ? writeActiveClaudeKeychainCredentials(previousLegacyKeychain)
          : deleteActiveClaudeKeychainCredentialsStrict())
      } catch (error) {
        cleanupError = error
      }
    }
    await removeTemporaryClaudeConfigDir(tempConfig)
    dependencies.setCancel(null)
  }
  if (captureError) {
    throw captureError
  }
  if (cleanupError) {
    throw cleanupError
  }
  return captured!
}

async function createTemporaryClaudeConfigDir(
  location: ClaudeManagedAuthLocation
): Promise<ClaudeCommandConfig> {
  if (location.managedAuthRuntime !== 'wsl') {
    return {
      windowsPath: mkdtempSync(join(tmpdir(), 'orca-claude-login-')),
      linuxPath: null,
      wslDistro: null
    }
  }
  if (!location.wslDistro) {
    throw new Error('Could not resolve the active WSL distribution for Claude login.')
  }
  const created = await runWslProcess({
    distro: location.wslDistro,
    loginPath: 'none',
    shell: 'bash',
    script: 'mktemp -d "${TMPDIR:-/tmp}/orca-claude-login.XXXXXX"',
    timeoutMs: 5000
  })
  const linuxPath = created.stdout.replaceAll(String.fromCharCode(0), '').trim()
  if (created.code !== 0 || created.timedOut || !linuxPath.startsWith('/')) {
    throw new Error('Could not create a temporary WSL Claude login directory.')
  }
  return {
    windowsPath: toWindowsWslPath(linuxPath, location.wslDistro),
    linuxPath,
    wslDistro: location.wslDistro
  }
}

async function removeTemporaryClaudeConfigDir(config: ClaudeCommandConfig): Promise<void> {
  if (config.linuxPath && config.wslDistro) {
    try {
      await runWslProcess({
        distro: config.wslDistro,
        loginPath: 'none',
        program: 'rm',
        args: ['-rf', '--', config.linuxPath],
        timeoutMs: 5000
      })
    } catch {
      // Cleanup cannot mask the login result.
    }
    return
  }
  rmSync(config.windowsPath, { recursive: true, force: true })
}
