import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveCodexCommandForSpawn } from '../codex-cli/command'

export type CodexLoginStatus = {
  authenticated: boolean
  authKind: 'oauth' | 'api-key' | 'none'
}

const LOGIN_STATUS_TIMEOUT_MS = 10_000
const BACKGROUND_REFRESH_INTERVAL_MS = 30_000

/** Asks the Codex CLI whether its configured credential store holds a login for `codexHomePath`. */
export type CodexLoginStatusProbe = {
  /** Cached result of the last probe; null before the first probe resolves. */
  read(): CodexLoginStatus | null
  /** Runs a probe, sharing one child process between concurrent callers. */
  refresh(): Promise<CodexLoginStatus | null>
  /** Fire-and-forget refresh for sync callers, throttled so snapshots cannot spawn in a loop. */
  refreshIfStale(now?: number): void
}

export function parseCodexLoginStatusText(
  text: string,
  exitCode: number | null
): CodexLoginStatus | null {
  if (/Not logged in/.test(text)) {
    return { authenticated: false, authKind: 'none' }
  }
  if (exitCode === 0 || /Logged in using|API key configured/.test(text)) {
    return {
      authenticated: true,
      authKind: /ChatGPT|Logged in using (?:personal )?access token/.test(text)
        ? 'oauth'
        : 'api-key'
    }
  }
  return null
}

export function createCodexLoginStatusProbe(
  getCodexHomePath: () => string,
  runLoginStatus: (
    codexHomePath: string
  ) => Promise<{ text: string; code: number | null }> = runCodexLoginStatus
): CodexLoginStatusProbe {
  let cached: CodexLoginStatus | null = null
  let lastAttemptAt = 0
  let inflight: Promise<CodexLoginStatus | null> | null = null
  let lastWarnedError: string | null = null

  const warnOnce = (message: string): void => {
    if (lastWarnedError === message) {
      return
    }
    lastWarnedError = message
    console.warn('[codex-accounts]', message)
  }

  const probe = async (): Promise<CodexLoginStatus | null> => {
    lastAttemptAt = Date.now()
    try {
      const { text, code } = await runLoginStatus(getCodexHomePath())
      const status = parseCodexLoginStatusText(text, code)
      if (status) {
        cached = status
        lastWarnedError = null
        return status
      }
      warnOnce(
        `Codex login status was unrecognized: ${text.trim().slice(0, 200) || `exit ${code}`}`
      )
      return cached
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warnOnce(`Codex login status check failed: ${reason}`)
      return cached
    }
  }

  const refresh = (): Promise<CodexLoginStatus | null> => {
    inflight ??= probe().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    read: () => cached,
    refresh,
    refreshIfStale: (now = Date.now()) => {
      if (inflight || now - lastAttemptAt < BACKGROUND_REFRESH_INTERVAL_MS) {
        return
      }
      void refresh()
    }
  }
}

async function runCodexLoginStatus(codexHomePath: string): Promise<{
  text: string
  code: number | null
}> {
  const codexCommand = await resolveCodexCommandForSpawn()
  const result = await runProcess({
    program: codexCommand,
    args: ['login', 'status'],
    env: withCliRuntimeOnPath(codexCommand, { ...process.env, CODEX_HOME: codexHomePath }),
    timeoutMs: LOGIN_STATUS_TIMEOUT_MS
  })
  if (result.timedOut) {
    throw new Error('Codex login status check timed out')
  }
  // `codex login status` prints every outcome on stderr; keep stdout for forward compatibility.
  return { text: `${result.stdout}\n${result.stderr}`, code: result.code }
}

/** System-default sign-in lives in the real ~/.codex, so its probe reads that home. */
export const systemDefaultCodexLoginStatus: CodexLoginStatusProbe = createCodexLoginStatusProbe(
  () => join(homedir(), '.codex')
)
