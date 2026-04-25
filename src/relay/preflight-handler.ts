import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import type { RelayDispatcher } from './dispatcher'

const execFileAsync = promisify(execFile)

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

    return { agents: results.filter((r) => r.installed).map((r) => r.id) }
  }

  // Why: SSH exec channels give the relay a minimal environment without
  // .zprofile/.bash_profile sourced. Running `which` directly would miss
  // agents installed via Homebrew, nvm, cargo, pipx, etc. Spawning a login
  // shell (`-lc`) ensures PATH matches what the user's PTY sessions see.
  private async isCommandOnPath(command: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-lc', `which ${command}`], {
        encoding: 'utf-8',
        timeout: 5000
      })
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .some((line) => path.isAbsolute(line))
    } catch {
      return false
    }
  }
}
