import type { WslPreflightTarget } from '../ipc/preflight-wsl-agent-detection'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import {
  execCommandInWslOrThrow,
  execLocalPreflightCommandOrThrow,
  shellQuote
} from '../ipc/preflight-command-exec'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from '../ipc/tui-agent-detection-commands'

// Why: keep a wedged remote host from delaying local integration status.
const REMOTE_FORGE_PROBE_TIMEOUT_MS = 8000

function uniqueAgentIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)]
}

export async function detectRemoteAgents(args: { connectionId: string }): Promise<string[]> {
  const mux = getActiveMultiplexer(args.connectionId)
  if (!mux || mux.isDisposed()) {
    // Why: remote agent detection is passive UI polling. A disconnected host has
    // no detectable agents until reconnect, but should not spam IPC errors.
    return []
  }
  const result = (await mux.request('preflight.detectAgents', {
    commands: KNOWN_TUI_AGENT_DETECTION_COMMANDS
  })) as { agents: string[] }
  return uniqueAgentIds(result.agents)
}

export async function detectRemoteForgeClis(args: {
  connectionId: string
}): Promise<Record<string, { installed: boolean; authenticated: boolean }> | null> {
  const mux = getActiveMultiplexer(args.connectionId)
  if (!mux || mux.isDisposed()) {
    return null
  }
  try {
    const result = (await mux.request(
      'preflight.detectForgeClis',
      { clis: ['gh', 'glab'] },
      { timeoutMs: REMOTE_FORGE_PROBE_TIMEOUT_MS }
    )) as { results?: Record<string, { installed: boolean; authenticated: boolean }> } | null
    return result?.results ?? null
  } catch {
    // Old relays do not implement this optional RPC; unknown must not read false.
    return null
  }
}

export async function isGhAuthenticated(wslTarget?: WslPreflightTarget): Promise<boolean> {
  try {
    await (wslTarget
      ? execCommandInWslOrThrow(wslTarget, `${shellQuote('gh')} auth status`)
      : execLocalPreflightCommandOrThrow('gh', ['auth', 'status']))
    // Why: for plain-text `gh auth status`, exit 0 means gh did not detect any
    // authentication issues for the checked hosts/accounts.
    return true
  } catch (error) {
    // Why: some environments may surface partial command output on the thrown
    // error object. Keep a compatibility fallback so we avoid a false auth
    // warning if success markers are present despite a non-zero result.
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in') || output.includes('Active account: true')
  }
}

// Why: parallel to isGhAuthenticated for the glab CLI. glab writes auth
// status to stderr in some versions and stdout in others; check both.
export async function isGlabAuthenticated(wslTarget?: WslPreflightTarget): Promise<boolean> {
  try {
    await (wslTarget
      ? execCommandInWslOrThrow(wslTarget, `${shellQuote('glab')} auth status`)
      : execLocalPreflightCommandOrThrow('glab', ['auth', 'status']))
    return true
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in')
  }
}
