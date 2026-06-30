import type { RelayDispatcher } from './dispatcher'
import { isCommandOnPathForRelay } from './relay-command-path-lookup'
import { isPwshAvailable } from '../main/pwsh'
import { isWslAvailable, listWslDistros } from '../main/wsl'
import { isGitBashAvailable } from '../main/git-bash'

export {
  _resetRelayCommandPathCacheForTests,
  buildCommandLookupSpec,
  buildCommandLookupSpecs,
  hasAbsoluteCommandPath,
  isCommandOnPathForRelay,
  resolveCommandLaunchForRelay,
  resolveCommandPathForRelay
} from './relay-command-path-lookup'

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
  }

  // Why: the client sends the command list rather than importing TUI_AGENT_CONFIG
  // on the relay side. This keeps the relay bundle minimal and makes the protocol
  // self-describing — the relay doesn't need to know the agent catalog.
  private async detectAgents(params: Record<string, unknown>): Promise<{ agents: string[] }> {
    const commands = params.commands as { id: string; cmd: string }[]
    if (!Array.isArray(commands)) {
      return { agents: [] }
    }

    const results = await Promise.all(
      commands.map(async ({ id, cmd }) => ({
        id,
        installed: await this.isCommandOnPath(cmd)
      }))
    )

    return { agents: [...new Set(results.filter((r) => r.installed).map((r) => r.id))] }
  }

  private async detectWindowsTerminalCapabilities(): Promise<{
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }> {
    const [wslAvailable, pwshAvailable, gitBashAvailable] = await Promise.all([
      Promise.resolve(isWslAvailable()).catch(() => false),
      Promise.resolve(isPwshAvailable()).catch(() => false),
      Promise.resolve(isGitBashAvailable()).catch(() => false)
    ])
    const wslDistros = wslAvailable ? await Promise.resolve(listWslDistros()).catch(() => []) : []
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
  private async isCommandOnPath(command: string): Promise<boolean> {
    return isCommandOnPathForRelay(command)
  }
}
