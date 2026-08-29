import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import type {
  DesktopPtyDataEvent,
  DesktopPtyExitEvent,
  DesktopPtyKillArgs,
  DesktopPtyResizeArgs,
  DesktopPtySpawnArgs,
  DesktopPtySpawnResult,
  DesktopPtyWriteArgs
} from '../shared/desktop-host-protocol'

type DesktopPtySession = {
  id: string
  process: pty.IPty
  cwd: string
}

export type DesktopHostPtyBrokerEvents = {
  data: [DesktopPtyDataEvent]
  exit: [DesktopPtyExitEvent]
}

function defaultShellCommand(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

function mergePtyEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  if (overrides) {
    Object.assign(env, overrides)
  }
  if (!env.TERM) {
    env.TERM = 'xterm-256color'
  }
  return env
}

export class DesktopHostPtyBroker extends EventEmitter<DesktopHostPtyBrokerEvents> {
  private readonly sessions = new Map<string, DesktopPtySession>()

  spawn(args: DesktopPtySpawnArgs): DesktopPtySpawnResult {
    const id = randomUUID()
    const cwd = args.cwd?.trim() || homedir() || process.cwd()
    const command = args.command?.trim() || defaultShellCommand()
    const spawned = pty.spawn(command, [], {
      name: 'xterm-256color',
      cols: Math.max(2, args.cols),
      rows: Math.max(2, args.rows),
      cwd,
      env: mergePtyEnv(args.env)
    })
    const session: DesktopPtySession = { id, process: spawned, cwd }
    this.sessions.set(id, session)
    spawned.onData((data) => {
      this.emit('data', { id, data })
    })
    spawned.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      this.emit('exit', { id, code: exitCode })
    })
    return { id }
  }

  write(args: DesktopPtyWriteArgs): boolean {
    const session = this.sessions.get(args.id)
    if (!session) {
      return false
    }
    session.process.write(args.data)
    return true
  }

  resize(args: DesktopPtyResizeArgs): boolean {
    const session = this.sessions.get(args.id)
    if (!session) {
      return false
    }
    session.process.resize(Math.max(2, args.cols), Math.max(2, args.rows))
    return true
  }

  kill(args: DesktopPtyKillArgs): boolean {
    const session = this.sessions.get(args.id)
    if (!session) {
      return false
    }
    session.process.kill()
    this.sessions.delete(args.id)
    return true
  }

  listSessions(): { id: string; cwd: string }[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      cwd: session.cwd
    }))
  }

  getCwd(id: string): string | null {
    return this.sessions.get(id)?.cwd ?? null
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.process.kill()
      } catch {
        // Why: a dying PTY should not block host shutdown.
      }
    }
    this.sessions.clear()
  }
}
