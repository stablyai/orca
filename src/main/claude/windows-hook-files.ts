import { existsSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { getLockedExecutableAsidePath } from '../agent-hooks/locked-executable-rename'
import {
  refreshManagedScriptIfPresent,
  restoreManagedScript,
  scriptStillExists
} from '../agent-hooks/managed-hook-script-refresh'
import {
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import {
  resolveBundledWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME
} from '../agent-hooks/windows-native-hook-executable'
import { WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD } from './hook-script'

const PAYLOAD_FILE_NAME = 'claude-hook-impl.cmd'

export function getWindowsClaudeHookPayloadPath(entryPath: string): string {
  return join(dirname(entryPath), PAYLOAD_FILE_NAME)
}

export function getWindowsClaudeHookExecutablePath(entryPath: string): string {
  return join(dirname(entryPath), WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME)
}

/**
 * Copies the bundled hook beside the `.cmd` entry and returns the copy to register, or null to
 * register the `.cmd` hook. Byte-for-byte, like the daemon-host relocation, so the copy keeps its
 * Authenticode signature.
 */
export function installWindowsClaudeHookExecutable(entryPath: string): string | null {
  const destination = getWindowsClaudeHookExecutablePath(entryPath)
  try {
    rmSync(getLockedExecutableAsidePath(destination), { force: true })
  } catch {
    // Still running; a later install removes it.
  }
  const source = resolveBundledWindowsNativeHookExecutable()
  try {
    if (source) {
      writeManagedScript(destination, readFileSync(source), { moveLockedTargetAside: true })
      return destination
    }
  } catch {
    // No bundled binary (dev checkout), or the copy and its aside are both still running.
  }
  // Every exe build knows `claude`, so a copy already in place stays registered.
  return existsSync(destination) ? destination : null
}

export function getWindowsClaudeHookFileStatus(
  status: AgentHookInstallStatus,
  entryPath: string,
  exeRegistered: boolean
): AgentHookInstallStatus {
  if (
    status.state === 'installed' &&
    (!existsSync(entryPath) ||
      !existsSync(getWindowsClaudeHookPayloadPath(entryPath)) ||
      (exeRegistered && !existsSync(getWindowsClaudeHookExecutablePath(entryPath))))
  ) {
    return { ...status, state: 'partial', detail: 'Managed Claude hook script is missing' }
  }
  return status
}

export function installWindowsClaudeHookFiles(entryPath: string, payload: string): void {
  writeManagedScript(getWindowsClaudeHookPayloadPath(entryPath), payload)
  writeManagedScript(entryPath, getWindowsClaudeHookEntry())
}

export function getWindowsClaudeHookEntry(): string {
  return [
    '@echo off',
    // Inherited delayed expansion would eat exclamation marks in the profile path.
    'setlocal DisableDelayedExpansion',
    `set "ORCA_CLAUDE_HOOK_IMPL=%~dp0${PAYLOAD_FILE_NAME}"`,
    'if not exist "%ORCA_CLAUDE_HOOK_IMPL%" goto :missing_impl',
    // Transfer control without CALL's second expansion of percent signs in the path.
    // A payload that exists but cannot start (locked, quarantined) falls through to the neutral reply.
    '"%ORCA_CLAUDE_HOOK_IMPL%"',
    ':missing_impl',
    'echo {}',
    ...buildWindowsHookEnvironmentGuardLines(),
    WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD,
    ...buildWindowsHookStdinDrainEpilogue(),
    ''
  ].join('\r\n')
}

export async function refreshWindowsClaudeHookFiles(
  entryPath: string,
  payload: string
): Promise<void> {
  // A surviving exe copy is Orca-owned too; a running one is moved aside, as in install().
  const bundledHook = resolveBundledWindowsNativeHookExecutable()
  if (bundledHook) {
    const executable = getWindowsClaudeHookExecutablePath(entryPath)
    await readFile(bundledHook)
      .then((bytes) =>
        refreshManagedScriptIfPresent(executable, bytes, { moveLockedTargetAside: true })
      )
      .catch(() => {})
  }
  // A surviving entry is Orca-owned; creating a missing one stays install()'s presence-gated job.
  if (!(await scriptStillExists(entryPath))) {
    return
  }
  // Publish the payload first so a failed migration leaves the previous single-file hook intact.
  await restoreManagedScript(getWindowsClaudeHookPayloadPath(entryPath), payload)
  await restoreManagedScript(entryPath, getWindowsClaudeHookEntry())
}
