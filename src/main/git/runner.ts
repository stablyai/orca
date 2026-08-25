/**
 * Centralized git/gh/command runner with transparent WSL support.
 *
 * Why: when a repo lives on a WSL filesystem, native Windows binaries (git.exe,
 * gh.exe, rg.exe) are absent or slow, so this routes execution through
 * `wsl.exe -d <distro>` with translated Linux paths.
 *
 * The implementation lives in ./command-runner/*; this module stays the entry
 * point its ~100 call sites (and their vi.mock factories) import from.
 */
// Re-exported for existing importers; lightweight consumers should import from './exec-error' to avoid this heavy module.
export { extractExecError, parseRetryAfterMs } from './exec-error'

export { setDefaultWslDistroOverride } from './command-runner/wsl-command-resolution'
export {
  awaitWindowsHostGitEnvironmentReady,
  configureWindowsHostGitEnvironmentReadiness
} from './command-runner/windows-host-git-environment'
export { DEFAULT_GIT_MAX_BUFFER } from './command-runner/git-exec-options'
export {
  appendGitConfigEnv,
  gitOptionalLocksDisabledEnv,
  nonInteractiveGitEnv,
  promptGuardGitEnv,
  promptGuardShellEnv,
  untranslatedGitOutputEnv
} from './command-runner/git-process-env'
export {
  gitExecFileAsync,
  gitExecFileAsyncBuffer,
  gitExecFileSync
} from './command-runner/git-exec-file'
export { commandExecFileAsync } from './command-runner/command-exec-file'
export { gitStreamStdout, type GitStreamResult } from './command-runner/git-stream-stdout'
export { gitSpawn, gitSpawnAfterWindowsEnvironmentReady } from './command-runner/git-spawn'
export { isTransientGhError } from './command-runner/gh-retry-policy'
export { applyGhHostToArgs } from './command-runner/gh-host-args'
export { ghExecFileAsync } from './command-runner/gh-exec-file'
export { glabExecFileAsync, redirectPortedHostnameToEnv } from './command-runner/glab-exec-file'
export { wslAwareSpawn } from './command-runner/wsl-aware-spawn'
export { translateWslOutputPaths } from './command-runner/wsl-path-translation'

/** Convenience re-export of wsl.ts path helpers so consumers don't import it directly. */
export { parseWslPath, toLinuxPath, toWindowsWslPath, isWslPath } from '../wsl'
