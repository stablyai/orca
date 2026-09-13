import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayCommandEnv } from './relay-command-env'
import { isPwshAvailableAsync } from '../main/pwsh'
import { isWslAvailableAsync, listWslDistrosAsync } from '../main/wsl'
import { isGitBashAvailable } from '../main/git-bash'
import {
  buildCommandLookupSpec,
  buildCommandLookupSpecs,
  firstAbsoluteCommandPath,
  hasAbsoluteCommandPath
} from './relay-command-lookup'

export { buildCommandLookupSpec, buildCommandLookupSpecs, firstAbsoluteCommandPath, hasAbsoluteCommandPath }

const execFileAsync = promisify(execFile)

type RelayCommandLookupOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  accountLoginShell?: string | null
}

type AgentDetectionRuntime = NodeJS.Platform | 'wsl'

type AgentDetectionCommand = {
  id: string
  cmd: string
  requiredCommands?: readonly string[]
  unsupportedRuntimes?: readonly AgentDetectionRuntime[]
}

const FORGE_CLI_ALLOWLIST = new Set(['gh', 'glab'])
// Why: the caller abandons at 8s (REMOTE_FORGE_PROBE_TIMEOUT_MS in
// src/main/ipc/preflight.ts), and a forge probe pays lookup then auth, so both
// budgets together must stay under it.
const RELAY_COMMAND_LOOKUP_TIMEOUT_MS = 2_000
const FORGE_AUTH_TIMEOUT_MS = 5_000

export class PreflightHandler {
  private dispatcher: RelayDispatcher

  constructor(dispatcher: RelayDispatcher) {
    this.dispatcher = dispatcher
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('preflight.detectAgents', (p) => this.detectAgents(p))
    this.dispatcher.onRequest('preflight.detectWindowsTerminalCapabilities', () =>
      this.detectWindowsTerminalCapabilities()
    )
    this.dispatcher.onRequest('preflight.detectForgeClis', (p) => this.detectForgeClis(p))
  }

  // Why: the client sends the command list rather than importing TUI_AGENT_CONFIG
  // on the relay side. This keeps the relay bundle minimal and makes the protocol
  // self-describing — the relay doesn't need to know the agent catalog.
  private async detectAgents(params: Record<string, unknown>): Promise<{ agents: string[] }> {
    const commands = params.commands as AgentDetectionCommand[]
    if (!Array.isArray(commands)) {
      return { agents: [] }
    }
    const probeCommands = [
      ...new Set(
        commands
          .filter((command) => !isDetectionUnsupportedInRuntime(command, process.platform))
          .flatMap((command) => [command.cmd, ...(command.requiredCommands ?? [])])
      )
    ]

    const results = await Promise.all(
      probeCommands.map(async (cmd) => ({
        cmd,
        installed: (await this.resolveCommandPath(cmd)) !== null
      }))
    )
    const foundCommands = new Set(
      results.filter((result) => result.installed).map(({ cmd }) => cmd)
    )

    return {
      agents: [
        ...new Set(
          commands
            .filter(
              (command) =>
                !isDetectionUnsupportedInRuntime(command, process.platform) &&
                foundCommands.has(command.cmd) &&
                (command.requiredCommands ?? []).every((required) => foundCommands.has(required))
            )
            .map(({ id }) => id)
        )
      ]
    }
  }

  private async detectWindowsTerminalCapabilities(): Promise<{
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }> {
    const [wslAvailable, pwshAvailable, gitBashAvailable] = await Promise.all([
      isWslAvailableAsync().catch(() => false),
      isPwshAvailableAsync().catch(() => false),
      Promise.resolve(isGitBashAvailable()).catch(() => false)
    ])
    const wslDistros = wslAvailable ? await listWslDistrosAsync().catch(() => []) : []
    return {
      wslAvailable,
      wslDistros,
      pwshAvailable,
      gitBashAvailable,
      hostPlatform: process.platform
    }
  }

  // Why: SSH exec channels give the relay a minimal environment without shell
  // startup files sourced. Ask the user's configured shell so agent dirs added
  // by zsh/bash/fish startup hooks match the remote terminal experience.
  // Windows has no POSIX shell on native OpenSSH hosts, so use where.exe there.
  private async resolveCommandPath(command: string): Promise<string | null> {
    return resolveRelayCommandPath(command)
  }

  // Why: ignore rather than error on non-allowlisted entries — a newer desktop
  // probing a CLI this relay doesn't know must degrade, mirroring how missing
  // methods degrade.
  private async detectForgeClis(
    params: Record<string, unknown>
  ): Promise<{ results: Record<string, { installed: boolean; authenticated: boolean }> }> {
    // Why: iterate the allowlist, not the request — duplicated names would
    // otherwise spawn one probe per repetition.
    const requested = new Set(Array.isArray(params.clis) ? (params.clis as string[]) : [])
    const clis = [...FORGE_CLI_ALLOWLIST].filter((cli) => requested.has(cli))
    const results: Record<string, { installed: boolean; authenticated: boolean }> = {}
    await Promise.all(
      clis.map(async (cli) => {
        // Why: detection resolves through a login shell, so a PATH set in a
        // shell startup file is visible here but not to a bare execFile. Reuse
        // the resolved executable so "installed" and "authenticated" can never
        // disagree about which binary they mean.
        const executable = await this.resolveCommandPath(cli)
        results[cli] = {
          installed: executable !== null,
          authenticated:
            executable !== null && (await isForgeCliAuthenticated(cli as 'gh' | 'glab', executable))
        }
      })
    )
    return { results }
  }
}

// Why: glab writes auth status to stderr in some versions and can exit
// non-zero while still logged in, so check output markers on failure too.
// Markers mirror the main-process per-CLI checks (isGhAuthenticated /
// isGlabAuthenticated in src/main/ipc/preflight.ts).
async function isForgeCliAuthenticated(cli: 'gh' | 'glab', executable: string): Promise<boolean> {
  try {
    await execFileAsync(executable, ['auth', 'status'], {
      encoding: 'utf-8',
      env: buildRelayCommandEnv(),
      timeout: FORGE_AUTH_TIMEOUT_MS,
      windowsHide: true
    })
    return true
  } catch (error) {
    // Why: killed or timed-out probes keep partial output, so a hung `auth status`
    // that already printed "Logged in" must read as unknown, never a yes.
    const failure = error as {
      stdout?: string
      stderr?: string
      killed?: boolean
      signal?: string
      code?: string
    }
    if (failure.killed === true || failure.signal != null || failure.code === 'ETIMEDOUT') {
      return false
    }
    const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`
    return cli === 'gh'
      ? output.includes('Logged in') || output.includes('Active account: true')
      : output.includes('Logged in')
  }
}

function isDetectionUnsupportedInRuntime(
  command: AgentDetectionCommand,
  runtime: AgentDetectionRuntime
): boolean {
  return command.unsupportedRuntimes?.includes(runtime) === true
}

/**
 * Resolve `command` to an absolute path using the same shell-aware probes as
 * detection, so callers that spawn it cannot disagree with detection about
 * which binary they mean when PATH comes from a shell startup file.
 */
export async function resolveRelayCommandPath(
  command: string,
  options: RelayCommandLookupOptions = {}
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const specs = buildCommandLookupSpecs(command, platform, env, options.accountLoginShell)

  for (const spec of specs) {
    try {
      const { stdout } = await execFileAsync(spec.file, spec.args, {
        encoding: 'utf-8',
        env: buildRelayCommandEnv(env, platform),
        timeout: RELAY_COMMAND_LOOKUP_TIMEOUT_MS,
        ...(spec.windowsHide ? { windowsHide: true } : {})
      })
      const resolved = firstAbsoluteCommandPath(stdout, platform)
      if (resolved !== null) {
        return resolved
      }
    } catch {
      // Try the inherited-PATH fallback before reporting the command missing.
    }
  }

  return null
}

/**
 * Boolean form of {@link resolveRelayCommandPath} for callers that only need to
 * know whether `command` is on PATH (e.g. TUI agent detection).
 */
export async function isCommandOnPathForRelay(
  command: string,
  options: RelayCommandLookupOptions = {}
): Promise<boolean> {
  return (await resolveRelayCommandPath(command, options)) !== null
}
