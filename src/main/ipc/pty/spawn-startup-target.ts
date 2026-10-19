// Where a new PTY starts and in which shell/runtime, for both the window and the host spawn lane.

import {
  isWslShellName,
  type LocalWindowsTerminalRuntimeOptions
} from '../../../shared/local-windows-terminal-runtime'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { TerminalStartupCwdMissingDirFallback } from '../../../shared/terminal-startup-cwd'
import { isWslUncPath, toWindowsWslPath } from '../../../shared/wsl-paths'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'
import { resolveWslSessionContext } from '../../daemon/wsl-session-context'
import {
  resolveLocalProjectRuntimeForWorktreeId,
  resolveLocalPtyOptions,
  type ProjectRuntimeResolutionStore
} from '../../local-project-runtime-resolution'
import { normalizeWindowsTerminalCwd } from '../../providers/windows-shell-args'
import { wslUncDirectoryExistsAsync } from '../../wsl'
import { getCodexSelectionTargetForPty } from './host-env/codex-home'

// TEMPORARY (row 13b removes it): the window uses the renderer's runtime; the host reads the store.
export type PtySpawnProjectRuntimeSource =
  | { kind: 'sent'; projectRuntime: ProjectExecutionRuntimeResolution | undefined }
  | { kind: 'store'; store: ProjectRuntimeResolutionStore | undefined }

export type PtySpawnStartupTarget = {
  cwd: string | undefined
  /** Already proven to exist by the WSL probe. */
  prevalidatedCwd?: string
  startupCwdFallback?: { kind: 'worktree'; cwd: string }
  terminalRuntimeOptions: LocalWindowsTerminalRuntimeOptions
  expectedWslDistro: string | null
  codexSelectionTarget: CodexAccountSelectionTarget
}

type PtySpawnStartupArgs = {
  worktreeId: string | undefined
  cwd: string | undefined
  /** Its worktree can imply the WSL distro. */
  sessionId: string | undefined
  shellOverride: string | undefined
  /** The PTY an agent launch's command was quoted for. */
  plannedPty?: LocalWindowsTerminalRuntimeOptions
  projectRuntimeSource: PtySpawnProjectRuntimeSource
  /** TEMPORARY (row 13a removes it): only window starts fall back to the root of a missing cwd. */
  missingCwdFallback?: { directoryExists: (path: string) => boolean }
  getSettings: (() => Parameters<typeof resolveLocalPtyOptions>[0]) | undefined
  resolveStartupCwd: (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback
  ) => string | undefined
}

export async function resolvePtySpawnStartupTarget(
  args: PtySpawnStartupArgs
): Promise<PtySpawnStartupTarget> {
  const source = args.projectRuntimeSource
  const terminalRuntimeOptions =
    args.plannedPty ??
    resolveLocalPtyOptions(
      args.getSettings?.(),
      source.kind === 'sent'
        ? source.projectRuntime
        : resolveLocalProjectRuntimeForWorktreeId(source.store, args.worktreeId),
      args.shellOverride,
      process.env.COMSPEC || 'powershell.exe'
    )
  const startup = args.missingCwdFallback
    ? await resolveStartupCwdWithFallback(args, args.missingCwdFallback, terminalRuntimeOptions)
    : { cwd: args.resolveStartupCwd(args.worktreeId, args.cwd) }
  const expectedWslDistro =
    resolveWslSessionContext({
      cwd: startup.cwd,
      sessionId: args.sessionId,
      shellOverride: terminalRuntimeOptions.shellOverride,
      terminalWindowsWslDistro: terminalRuntimeOptions.terminalWindowsWslDistro
    })?.distro ?? null
  return {
    ...startup,
    terminalRuntimeOptions,
    expectedWslDistro,
    codexSelectionTarget: getCodexSelectionTargetForPty(
      terminalRuntimeOptions.shellOverride,
      startup.cwd,
      expectedWslDistro
    )
  }
}

async function resolveStartupCwdWithFallback(
  { worktreeId, resolveStartupCwd, ...args }: PtySpawnStartupArgs,
  fallback: { directoryExists: (path: string) => boolean },
  runtimeOptions: LocalWindowsTerminalRuntimeOptions
): Promise<Pick<PtySpawnStartupTarget, 'cwd' | 'prevalidatedCwd' | 'startupCwdFallback'>> {
  const isPosixStartupCwd = args.cwd?.startsWith('/') === true
  const startupWorkspaceCwd = isPosixStartupCwd ? resolveStartupCwd(worktreeId, '.') : undefined
  const initiallyResolvedStartupCwd = isPosixStartupCwd
    ? resolveStartupCwd(worktreeId, args.cwd)
    : undefined
  // Only a Windows runtime's shell can put a POSIX cwd inside WSL.
  const startupRuntime = process.platform === 'win32' ? runtimeOptions : undefined
  const wslRuntimeOwnsStartupCwd =
    isPosixStartupCwd &&
    (isWslShellName(startupRuntime?.shellOverride) || isWslUncPath(startupWorkspaceCwd ?? ''))
  const startupWslContext = wslRuntimeOwnsStartupCwd
    ? resolveWslSessionContext({
        cwd: startupWorkspaceCwd,
        shellOverride: startupRuntime?.shellOverride,
        terminalWindowsWslDistro: startupRuntime?.terminalWindowsWslDistro
      })
    : undefined
  let prevalidatedCwd: string | undefined
  let wslStartupCwdExists: boolean | null = null
  let wslWorkspaceCwdExists: boolean | null = null
  if (startupWslContext && initiallyResolvedStartupCwd) {
    const validationCwd = toWindowsWslPath(initiallyResolvedStartupCwd, startupWslContext.distro)
    wslStartupCwdExists = isWslUncPath(validationCwd)
      ? await wslUncDirectoryExistsAsync(validationCwd)
      : fallback.directoryExists(validationCwd)
    if (wslStartupCwdExists === true) {
      prevalidatedCwd = validationCwd
    }
    if (wslStartupCwdExists === false && startupWorkspaceCwd) {
      wslWorkspaceCwdExists = isWslUncPath(startupWorkspaceCwd)
        ? await wslUncDirectoryExistsAsync(startupWorkspaceCwd)
        : fallback.directoryExists(startupWorkspaceCwd)
      if (wslWorkspaceCwdExists === true) {
        prevalidatedCwd = startupWorkspaceCwd
      }
    }
  }
  const allowMissingCwdFallback =
    !wslRuntimeOwnsStartupCwd || (wslStartupCwdExists === false && wslWorkspaceCwdExists === true)
  let didFallbackToWorkspaceRootCwd = false
  const cwd = resolveStartupCwd(
    worktreeId,
    args.cwd,
    allowMissingCwdFallback
      ? {
          directoryExists: (path) =>
            startupWslContext &&
            wslStartupCwdExists === false &&
            path === initiallyResolvedStartupCwd
              ? false
              : startupWslContext && path === startupWorkspaceCwd
                ? wslWorkspaceCwdExists === true
                : fallback.directoryExists(
                    process.platform === 'win32' ? normalizeWindowsTerminalCwd(path) : path
                  ),
          onFallbackToWorkspaceRoot: () => {
            didFallbackToWorkspaceRootCwd = true
          }
        }
      : undefined
  )
  if (didFallbackToWorkspaceRootCwd && wslWorkspaceCwdExists === true && cwd) {
    prevalidatedCwd = cwd
  }
  return {
    cwd,
    prevalidatedCwd,
    startupCwdFallback: didFallbackToWorkspaceRootCwd && cwd ? { kind: 'worktree', cwd } : undefined
  }
}
