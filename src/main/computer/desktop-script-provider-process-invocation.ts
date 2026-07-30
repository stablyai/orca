import { execFile, type ExecFileException } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { SupervisedDesktopProviderResult } from './computer-provider-supervisor-protocol'
import {
  desktopScriptPlatform,
  resolveDesktopScriptProviderPath,
  type DesktopScriptPlatform
} from './desktop-script-provider-paths'
import { RuntimeClientError } from './runtime-client-error'

export const DESKTOP_PROVIDER_MAX_BUFFER_BYTES = 20 * 1024 * 1024

export type DesktopProviderExecutionPlan = {
  platform: DesktopScriptPlatform
  command: string
  scriptPath: string
  env: NodeJS.ProcessEnv
}

export type DesktopScriptProviderSupervisorDeps = {
  platform: () => DesktopScriptPlatform | null
  resolveScriptPath: (platform: DesktopScriptPlatform) => string | null
  execFile: typeof execFile
  randomUUID: () => string
  temporaryDirectory: () => string
  mkdtemp: typeof mkdtemp
  chmod: typeof chmod
  writeFile: typeof writeFile
  rmSync: typeof rmSync
  setTimer: (callback: () => void, timeoutMs: number) => NodeJS.Timeout
  clearTimer: (timer: NodeJS.Timeout) => void
}

export function desktopProviderExecutionPlan(
  deps: DesktopScriptProviderSupervisorDeps
): DesktopProviderExecutionPlan {
  const platform = deps.platform()
  if (!platform) {
    throw new RuntimeClientError(
      'accessibility_error',
      'desktop script provider is not available on this platform'
    )
  }
  const scriptPath = deps.resolveScriptPath(platform)
  if (!scriptPath) {
    throw new RuntimeClientError(
      'accessibility_error',
      'desktop script provider script was not found'
    )
  }
  return {
    platform,
    command: platform === 'windows' ? 'powershell.exe' : 'python3',
    scriptPath,
    env: { ...process.env }
  }
}

export function desktopProviderCommandArgs(
  plan: DesktopProviderExecutionPlan,
  operationPath: string
): string[] {
  return plan.platform === 'windows'
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        plan.scriptPath,
        operationPath
      ]
    : [plan.scriptPath, operationPath]
}

export function desktopProviderExecutionResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string
): SupervisedDesktopProviderResult {
  return {
    stdout,
    stderr,
    error: error
      ? {
          message: stderr.trim() || stdout.trim() || error.message,
          killed: error.killed === true
        }
      : null
  }
}

export function createDesktopScriptProviderSupervisorDeps(): DesktopScriptProviderSupervisorDeps {
  return {
    platform: desktopScriptPlatform,
    resolveScriptPath: resolveDesktopScriptProviderPath,
    execFile,
    randomUUID,
    temporaryDirectory: tmpdir,
    mkdtemp,
    chmod,
    writeFile,
    rmSync,
    setTimer: setTimeout,
    clearTimer: clearTimeout
  }
}
