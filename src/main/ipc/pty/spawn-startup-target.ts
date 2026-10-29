import {
  isWslShellName,
  type LocalWindowsTerminalRuntimeOptions
} from '../../../shared/local-windows-terminal-runtime'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { StartupCwdFallback } from '../../../shared/startup-cwd-fallback'
import type { TerminalStartupCwdMissingDirFallback } from '../../../shared/terminal-startup-cwd'
import { isWslUncPath, toWindowsWslPath } from '../../../shared/wsl-paths'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'
import { resolveWslSessionContext } from '../../daemon/wsl-session-context'
import {
  resolveLocalProjectRuntimeForWorktreeId,
  resolveLocalPtyOptions,
  type ProjectRuntimeResolutionStore
} from '../../local-project-runtime-resolution'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'
import { normalizeWindowsTerminalCwd } from '../../providers/windows-shell-args'
import { wslUncDirectoryExistsAsync } from '../../wsl'
import { getCodexSelectionTargetForPty } from './host-env/codex-home'
import { probeLocalStartupCwdDirectory } from './host-env/startup-cwd-directory-exists'

// Window runtime comes from the renderer; host runtime comes from persistence.
export type PtySpawnProjectRuntimeSource =
  | { kind: 'sent'; projectRuntime: ProjectExecutionRuntimeResolution | undefined }
  | { kind: 'store'; store: ProjectRuntimeResolutionStore | undefined }

export type PtySpawnStartupTarget = {
  cwd: string | undefined
  /** Already proven to exist by the WSL probe. */
  prevalidatedCwd?: string
  startupCwdFallback?: StartupCwdFallback
  correctStartupCwd?: string
  /** The cwd before any fallback; a reattach keeps it as the saved start folder. */
  requestedCwd: string | undefined
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
  /** A known live pane never uses the cwd, so it skips the existence probe. */
  preAdopted: boolean
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
  const startup = args.preAdopted
    ? {
        cwd: args.resolveStartupCwd(args.worktreeId, args.cwd),
        startupCwdFallback: undefined,
        correctStartupCwd: undefined
      }
    : await resolveStartupCwdWithFallback(args, terminalRuntimeOptions)
  const expectedWslDistro =
    resolveWslSessionContext({
      cwd: startup.cwd,
      sessionId: args.sessionId,
      shellOverride: terminalRuntimeOptions.shellOverride,
      terminalWindowsWslDistro: terminalRuntimeOptions.terminalWindowsWslDistro
    })?.distro ?? null
  return {
    ...startup,
    requestedCwd: startup.startupCwdFallback
      ? args.resolveStartupCwd(args.worktreeId, args.cwd)
      : startup.cwd,
    terminalRuntimeOptions,
    expectedWslDistro,
    codexSelectionTarget: getCodexSelectionTargetForPty(
      terminalRuntimeOptions.shellOverride,
      startup.cwd,
      expectedWslDistro
    )
  }
}

/** Reported only for a process proven started at the request's cwd, never for an attach. */
export function startupCwdFallbackOutcome(
  fallback: StartupCwdFallback | undefined,
  result: Pick<PtySpawnResult, 'startupCwdSource' | 'isReattach'>
): StartupCwdFallback | undefined {
  return fallback && result.startupCwdSource === 'request' && result.isReattach !== true
    ? fallback
    : undefined
}

async function resolveStartupCwdWithFallback(
  { worktreeId, resolveStartupCwd, ...args }: PtySpawnStartupArgs,
  runtimeOptions: LocalWindowsTerminalRuntimeOptions
): Promise<
  Pick<
    PtySpawnStartupTarget,
    'cwd' | 'prevalidatedCwd' | 'startupCwdFallback' | 'correctStartupCwd'
  >
> {
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
      : await probeLocalStartupCwdDirectory(validationCwd)
    if (wslStartupCwdExists === true) {
      prevalidatedCwd = validationCwd
    }
    if (
      wslStartupCwdExists !== true &&
      (!isWslUncPath(validationCwd) || wslStartupCwdExists === false) &&
      startupWorkspaceCwd
    ) {
      wslWorkspaceCwdExists = isWslUncPath(startupWorkspaceCwd)
        ? await wslUncDirectoryExistsAsync(startupWorkspaceCwd)
        : await probeLocalStartupCwdDirectory(startupWorkspaceCwd)
      if (wslWorkspaceCwdExists === true) {
        prevalidatedCwd = startupWorkspaceCwd
      }
    }
  }
  const allowMissingCwdFallback =
    !wslRuntimeOwnsStartupCwd || (wslStartupCwdExists !== true && wslWorkspaceCwdExists === true)
  let didFallbackToWorkspaceRootCwd = false
  let missingCwdProvenAbsent = false
  const probedDirectories = new Map<string, boolean | null>()
  let unprobedDirectory: string | undefined
  const missingDirFallback = (
    onFallbackToWorkspaceRoot?: () => void
  ): TerminalStartupCwdMissingDirFallback => ({
    directoryExists: (path) => {
      const probePath = process.platform === 'win32' ? normalizeWindowsTerminalCwd(path) : path
      const verdict =
        startupWslContext && path === initiallyResolvedStartupCwd
          ? wslStartupCwdExists
          : startupWslContext && path === startupWorkspaceCwd
            ? wslWorkspaceCwdExists
            : isWslUncPath(path)
              ? true
              : probedDirectories.get(probePath)
      if (verdict === undefined) {
        unprobedDirectory ??= probePath
      }
      missingCwdProvenAbsent ||= verdict === false
      return verdict === true
    },
    onFallbackToWorkspaceRoot
  })
  if (allowMissingCwdFallback) {
    // Replay synchronous resolution, asynchronously probing each requested folder until no unknown directory remains.
    for (;;) {
      unprobedDirectory = undefined
      resolveStartupCwd(worktreeId, args.cwd, missingDirFallback())
      if (unprobedDirectory === undefined) {
        break
      }
      probedDirectories.set(
        unprobedDirectory,
        await probeLocalStartupCwdDirectory(unprobedDirectory)
      )
    }
  }
  const cwd = resolveStartupCwd(
    worktreeId,
    args.cwd,
    allowMissingCwdFallback
      ? missingDirFallback(() => {
          didFallbackToWorkspaceRootCwd = true
        })
      : undefined
  )
  if (didFallbackToWorkspaceRootCwd && wslWorkspaceCwdExists === true && cwd) {
    prevalidatedCwd = cwd
  }
  return {
    cwd,
    prevalidatedCwd,
    correctStartupCwd: didFallbackToWorkspaceRootCwd && missingCwdProvenAbsent ? cwd : undefined,
    startupCwdFallback: didFallbackToWorkspaceRootCwd && cwd ? { kind: 'worktree', cwd } : undefined
  }
}
