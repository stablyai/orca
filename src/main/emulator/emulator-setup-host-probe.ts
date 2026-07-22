import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BackendAvailability } from './backends/emulator-backend'
import { inspectAndroidSetup } from './android/android-setup-probe'
import { getConfiguredAndroidSdkPath } from './android/android-sdk-host-discovery'
import { inspectIosSetup } from './ios-setup-probe'

const execFileAsync = promisify(execFile)

function listDirectory(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function hasInstalledSystemImage(path: string, remainingDepth = 4): boolean {
  if (remainingDepth < 0) {
    return false
  }
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === 'package.xml') {
        return true
      }
      if (
        entry.isDirectory() &&
        hasInstalledSystemImage(join(path, entry.name), remainingDepth - 1)
      ) {
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

async function runCommand(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, { env, timeout: 20_000 })
    return { ok: true, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message
    }
  }
}

export function inspectIosSetupFromHost() {
  return inspectIosSetup({
    platform: platform(),
    homedir: homedir(),
    exists: existsSync,
    listDirectory,
    run: runCommand
  })
}

export function inspectAndroidSetupFromHost(backend: BackendAvailability) {
  return inspectAndroidSetup({
    env: process.env,
    platform: platform(),
    homedir: homedir(),
    configuredPath: getConfiguredAndroidSdkPath(),
    exists: existsSync,
    hasInstalledSystemImage,
    backendAvailable: backend.available,
    backendMessage: backend.message
  })
}
