import { basename } from 'node:path'
import { userInfo } from 'node:os'
import { runProcess } from '../../shared/child-process/run-process'
import { initializeCodexAppServerConnection } from '../codex/codex-app-server-handshake'
import { runCodexAppServerSession } from '../codex/codex-app-server-session'

// Why: this module runs on the execution host, so every home it returns is a
// path on that host. Agent config homes are resolved here rather than by each
// installer, which otherwise assumes `~/.<agent>` and writes where the agent
// will never read.

const AGENT_HOME_MAX_LENGTH = 4096
const HOME_PROBE_TIMEOUT_MS = 8_000

export function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

/** Rejects anything that is not a plain absolute POSIX directory path. The
 *  execution host for these installers is POSIX; a Windows-shaped or
 *  control-character path is a probe that went wrong, not a home. */
export function normalizePosixAgentHome(candidate: string): string | null {
  if (
    candidate.length === 0 ||
    candidate.length > AGENT_HOME_MAX_LENGTH ||
    candidate !== candidate.trim() ||
    !candidate.startsWith('/') ||
    candidate.includes('\\') ||
    hasControlCharacter(candidate)
  ) {
    return null
  }
  return candidate.replace(/\/+$/, '') || '/'
}

export function resolveLoginShell(): string {
  const candidate = process.env.SHELL || userInfo().shell || '/bin/sh'
  if (!candidate.startsWith('/') || candidate.includes('\\') || hasControlCharacter(candidate)) {
    return '/bin/sh'
  }
  return candidate
}

function loginShellFlag(shell: string): string {
  const shellName = basename(shell)
  return shellName === 'sh' || shellName === 'dash' ? '-c' : '-lc'
}

function defaultAgentHome(home: string, directoryName: string): string {
  return `${home.replace(/\/+$/, '') || home}/${directoryName}`
}

export async function resolveExecutionHostGrokHome(
  home: string,
  signal?: AbortSignal
): Promise<string> {
  const fallback = defaultAgentHome(home, '.grok')
  try {
    const shell = resolveLoginShell()
    // Why: agent PTYs start login shells, so read the same profile-derived
    // GROK_HOME without opening two additional SSH exec channels.
    // Why: a non-zero exit needs no special case — it yields no stdout, and an
    // unparseable home already falls back.
    const { stdout } = await runProcess({
      program: shell,
      args: [loginShellFlag(shell), `printenv GROK_HOME | head -c ${AGENT_HOME_MAX_LENGTH + 1}`],
      timeoutMs: HOME_PROBE_TIMEOUT_MS,
      signal
    })
    return normalizePosixAgentHome(stdout.split(/\r?\n/, 1)[0] ?? '') ?? fallback
  } catch {
    signal?.throwIfAborted()
    return fallback
  }
}

/**
 * Asks the host's own Codex where its CODEX_HOME is.
 *
 * Reading the environment the way the Grok probe does is not enough here: a
 * `codex` launcher commonly exports CODEX_HOME inside the wrapper script, so it
 * exists only for the Codex process and a login shell reports nothing. The
 * app-server handshake returns the home the server actually resolved, which
 * costs no wrapper parsing and stays correct for any launcher shape.
 */
export async function resolveExecutionHostCodexHome(
  home: string,
  signal?: AbortSignal
): Promise<string> {
  const fallback = defaultAgentHome(home, '.codex')
  try {
    const shell = resolveLoginShell()
    const initializeResult = await runCodexAppServerSession(
      {
        // Why: launch through the login shell so the probe resolves `codex` the
        // same way the PTY does, wrapper included. That leaves no host CLI path
        // to pair a node runtime against, which is what `cliPath: null` means.
        command: shell,
        args: [loginShellFlag(shell), 'exec codex app-server'],
        cliPath: null,
        timeoutMs: HOME_PROBE_TIMEOUT_MS
      },
      async (rpc) => await initializeCodexAppServerConnection(rpc)
    )
    const reported = (initializeResult as { codexHome?: unknown } | null)?.codexHome
    return (typeof reported === 'string' ? normalizePosixAgentHome(reported) : null) ?? fallback
  } catch {
    // Why: an absent, old, or hung Codex must not fail hook installation. The
    // default home is still right for every launcher that does not redirect.
    signal?.throwIfAborted()
    return fallback
  }
}

/**
 * The Codex home only when the host redirects it away from `~/.codex`.
 *
 * `undefined` means "the default home", which every installer already assumes,
 * so a host with no redirection stays on exactly the path it uses today.
 */
export async function resolveRedirectedExecutionHostCodexHome(
  home: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  const resolved = await resolveExecutionHostCodexHome(home, signal)
  return resolved === defaultAgentHome(home, '.codex') ? undefined : resolved
}
