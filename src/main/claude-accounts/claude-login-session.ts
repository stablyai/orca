import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'

const LOGIN_TIMEOUT_MS = 180_000

type ClaudeLoginSessionDependencies = {
  runCommand: (
    args: string[],
    config: ClaudeCommandConfig,
    timeoutMs: number,
    options?: ClaudeCommandOptions
  ) => Promise<string>
  setCancel: (cancel: (() => boolean) | null) => void
}

/** Runs a hidden `claude auth login` that writes its login straight into the account's folder. */
export async function runClaudeLoginSession(
  folder: ClaudeCommandConfig,
  dependencies: ClaudeLoginSessionDependencies
): Promise<void> {
  const controller = new AbortController()
  dependencies.setCancel(() => {
    if (controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  })
  try {
    await dependencies.runCommand(['auth', 'login', '--claudeai'], folder, LOGIN_TIMEOUT_MS, {
      signal: controller.signal,
      keepStdinOpen: true
    })
  } finally {
    dependencies.setCancel(null)
  }
}
