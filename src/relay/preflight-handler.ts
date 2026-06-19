import { execFile } from 'child_process'
import { promisify } from 'util'
import path, { win32 } from 'path'
import type { RelayDispatcher } from './dispatcher'
import { buildRelayCommandEnv } from './relay-command-env'

const execFileAsync = promisify(execFile)

type CommandLookupSpec = {
  file: string
  args: string[]
  windowsHide?: true
}

export class PreflightHandler {
  private dispatcher: RelayDispatcher

  constructor(dispatcher: RelayDispatcher) {
    this.dispatcher = dispatcher
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('preflight.detectAgents', (p) => this.detectAgents(p))
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

  // Why: SSH exec channels give the relay a minimal environment without
  // .zprofile/.bash_profile sourced. Running `which` directly would miss
  // agents installed via Homebrew, nvm, cargo, pipx, etc. Spawning a login
  // shell (`-lc`) ensures PATH matches what the user's PTY sessions see.
  // Windows has no /bin/sh on native OpenSSH hosts, so use where.exe there.
  private async isCommandOnPath(command: string): Promise<boolean> {
    try {
      const spec = buildCommandLookupSpec(command, process.platform)
      const { stdout } = await execFileAsync(spec.file, spec.args, {
        encoding: 'utf-8',
        env: buildRelayCommandEnv(),
        timeout: 5000,
        ...(spec.windowsHide ? { windowsHide: true } : {})
      })
      return hasAbsoluteCommandPath(stdout, process.platform)
    } catch {
      return false
    }
  }
}

export function buildCommandLookupSpec(
  command: string,
  platform: NodeJS.Platform
): CommandLookupSpec {
  if (platform === 'win32') {
    return { file: 'where.exe', args: [command], windowsHide: true }
  }
  return { file: '/bin/sh', args: ['-lc', 'command -v "$1"', 'sh', command] }
}

export function hasAbsoluteCommandPath(output: string, platform: NodeJS.Platform): boolean {
  const pathOps = platform === 'win32' ? win32 : path
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => pathOps.isAbsolute(line))
}
