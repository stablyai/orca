/** Stable git/gh/glab execution entry point; implementations live in command-runner. */
// Lightweight consumers can import exec-error directly to avoid runner dependencies.
export { extractExecError, parseRetryAfterMs } from './exec-error'

export { setDefaultWslDistroOverride } from './command-runner/wsl-command-resolution'
export {
  awaitWindowsHostGitEnvironmentReady,
  configureWindowsHostGitEnvironmentReadiness
} from './command-runner/windows-host-git-environment'
export { DEFAULT_GIT_MAX_BUFFER } from './command-runner/git-exec-options'
export { GitCommandTimeoutError } from './command-runner/git-command-timeout'
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
export {
  gitSpawn,
  gitSpawnAfterWindowsEnvironmentReady,
  withGitAdmission
} from './command-runner/git-spawn'
export { isTransientGhError } from './command-runner/gh-retry-policy'
export { applyGhHostToArgs } from './command-runner/gh-host-args'
export { ghExecFileAsync, ghExecFileWithScopeAsync } from './command-runner/gh-exec-file'
export { glabExecFileAsync, redirectPortedHostnameToEnv } from './command-runner/glab-exec-file'
export { wslAwareSpawn } from './command-runner/wsl-aware-spawn'
export { translateWslOutputPaths } from './command-runner/wsl-path-translation'

export { parseWslPath, toLinuxPath, toWindowsWslPath, isWslPath } from '../wsl'
