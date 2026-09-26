import path from 'node:path'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayCommandEnv } from './relay-command-env'
import { resolveCommandPathsForRelay } from './relay-command-path-lookup'
import { isPwshAvailableAsync } from '../main/pwsh'
import { isWslAvailableAsync, listWslDistrosAsync } from '../main/wsl'
import { isGitBashAvailable } from '../main/git-bash'
import { runProcess } from '../shared/child-process/run-process'

type AgentDetectionRuntime = NodeJS.Platform | 'wsl'

type AgentDetectionCommand = {
  id: string
  cmd: string
  reportVersion?: true
  requiredCommands?: readonly string[]
  unsupportedRuntimes?: readonly AgentDetectionRuntime[]
}

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
  private async detectAgents(params: Record<string, unknown>): Promise<{
    agents: string[]
    versions?: Record<string, string>
  }> {
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

    const resolvedPaths = await resolveCommandPathsForRelay(probeCommands)
    const results = probeCommands.map((cmd) => ({
      cmd,
      executablePath: resolvedPaths.get(cmd) ?? null
    }))
    const foundCommands = new Set(
      results.filter((result) => result.executablePath !== null).map(({ cmd }) => cmd)
    )
    const detectedCommands = commands.filter(
      (command) =>
        !isDetectionUnsupportedInRuntime(command, process.platform) &&
        foundCommands.has(command.cmd) &&
        (command.requiredCommands ?? []).every((required) => foundCommands.has(required))
    )
    const versions: Record<string, string> = {}
    for (const command of detectedCommands) {
      if (
        command.id !== 'claude' ||
        command.reportVersion !== true ||
        versions.claude !== undefined
      ) {
        continue
      }
      const executablePath = results.find((result) => result.cmd === command.cmd)?.executablePath
      if (!executablePath) {
        continue
      }
      const version = await probeCommandVersion(executablePath)
      if (version) {
        versions[command.id] = version
      }
    }

    return {
      agents: [...new Set(detectedCommands.map(({ id }) => id))],
      ...(Object.keys(versions).length > 0 ? { versions } : {})
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
}

async function probeCommandVersion(executablePath: string): Promise<string | null> {
  try {
    const env = buildRelayCommandEnv(process.env, process.platform)
    const pathKey = process.platform === 'win32' && env.Path !== undefined ? 'Path' : 'PATH'
    const executableDir = path.dirname(executablePath)
    const inheritedPath = env[pathKey]
    const result = await runProcess({
      program: executablePath,
      args: ['--version'],
      env: {
        ...env,
        [pathKey]: inheritedPath
          ? `${executableDir}${path.delimiter}${inheritedPath}`
          : executableDir
      },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
    if (result.code !== 0) {
      return null
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}

function isDetectionUnsupportedInRuntime(
  command: AgentDetectionCommand,
  runtime: AgentDetectionRuntime
): boolean {
  return command.unsupportedRuntimes?.includes(runtime) === true
}
