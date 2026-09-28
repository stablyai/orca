import type { TransientPtyRequest } from './daemon-transient-pty-protocol'
import { z } from 'zod'
import { spawnBunPty, canUseBunPty } from './pty-subprocess/bun-pty-process'
import type { BunPtyProcess } from './pty-subprocess/bun-pty-process-contract'
import type { DaemonEvent } from './types'
import { forceKillPosixPtyProcessGroups } from '../pty/posix-pty-process-groups'

const text = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\0'))
export const transientPtyCommand = z.object({
  id: z.string().uuid(),
  file: text.min(1),
  args: z.array(text).max(256),
  cwd: text.min(1),
  env: z.record(z.string(), text),
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(500)
})
export type TransientPtyCommand = z.infer<typeof transientPtyCommand>
type Entry = {
  owner: string
  process: BunPtyProcess | null
  ended: boolean
  closing: boolean
  terminationAttempts: number
  timer: ReturnType<typeof setTimeout>
  listeners: { dispose(): void }[]
}

/** Client-leased probes never enter terminal sessions, history or persistence. */
export class DaemonTransientPtys {
  private disposed = false
  private readonly entries = new Map<string, Entry>()
  constructor(
    private readonly publish: (owner: string, event: DaemonEvent) => boolean,
    private readonly spawn = spawnBunPty,
    readonly available = canUseBunPty()
  ) {}

  ping(): { pong: true; capabilities?: { transientPty: 1 } } {
    return this.available ? { pong: true, capabilities: { transientPty: 1 } } : { pong: true }
  }

  route(owner: string, request: TransientPtyRequest, authenticated: boolean): unknown {
    if (!authenticated) {
      throw new Error('Transient PTY requires an authenticated stream')
    }
    switch (request.type) {
      case 'createTransientPty':
        return this.create(owner, request.payload)
      case 'writeTransientPty':
        this.write(owner, request.payload.id, request.payload.data)
        return {}
      case 'closeTransientPty':
        this.close(owner, request.payload.id)
        return {}
    }
  }

  async create(owner: string, input: unknown): Promise<{ pid: number }> {
    if (this.disposed) {
      throw new Error('Transient PTY service is shutting down')
    }
    if (!this.available) {
      throw new Error('Transient PTY runtime unavailable')
    }
    const command = transientPtyCommand.parse(input)
    if (this.entries.has(command.id) || this.entries.size >= 8) {
      throw new Error('Transient PTY capacity exceeded or ID already exists')
    }
    const entry: Entry = {
      owner,
      process: null,
      ended: false,
      closing: false,
      terminationAttempts: 0,
      listeners: [],
      timer: setTimeout(() => this.expire(command.id, entry), 30_000)
    }
    this.entries.set(command.id, entry)
    try {
      const proc = this.spawn({ ...command, windowsJobKillOnClose: true })
      entry.process = proc
      // Register before waiting for Windows spawn receipt so early output remains ordered.
      const data = proc.onData((output) => {
        if (entry.ended || entry.closing) {
          return
        }
        for (let offset = 0; offset < output.length; offset += 16_384) {
          if (
            !this.publish(owner, {
              type: 'event',
              event: 'data',
              sessionId: command.id,
              payload: { data: output.slice(offset, offset + 16_384) }
            })
          ) {
            this.end(command.id, entry, true)
            return
          }
        }
      })
      entry.listeners.push(data)
      const exit = proc.onExit(({ exitCode }) => {
        if (!entry.ended) {
          this.publish(owner, {
            type: 'event',
            event: 'exit',
            sessionId: command.id,
            payload: { code: exitCode }
          })
          this.end(command.id, entry, false)
        }
      })
      entry.listeners.push(exit)
      await proc.waitForSpawn?.()
      if (entry.ended) {
        data.dispose()
        exit.dispose()
      }
      if (entry.closing) {
        throw new Error('Transient PTY canceled during startup')
      }
      return { pid: proc.pid }
    } catch (error) {
      this.end(command.id, entry, true)
      throw error
    }
  }

  write(owner: string, id: string, data: string): void {
    const entry = this.requireOwned(owner, id)
    if (data.length > 32_768) {
      throw new Error('Transient PTY input too large')
    }
    entry.process?.write(data)
  }

  close(owner: string, id: string): void {
    const entry = this.entries.get(id)
    if (!entry) {
      return
    }
    this.requireOwned(owner, id)
    this.end(id, entry, true)
  }

  disconnect(owner: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.owner === owner) {
        this.end(id, entry, true)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const [id, entry] of this.entries) {
      this.end(id, entry, true)
    }
  }

  private expire(id: string, entry: Entry): void {
    if (entry.ended) {
      return
    }
    this.end(id, entry, true)
  }

  private requireOwned(owner: string, id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner || entry.ended || entry.closing) {
      throw new Error('Transient PTY not owned')
    }
    return entry
  }

  private end(id: string, entry: Entry, kill: boolean): void {
    if (entry.ended) {
      return
    }
    if (kill && entry.process) {
      if (entry.closing) {
        return
      }
      entry.closing = true
      clearTimeout(entry.timer)
      this.terminate(id, entry)
      return
    }
    entry.ended = true
    clearTimeout(entry.timer)
    this.entries.delete(id)
    for (const listener of entry.listeners.splice(0)) {
      listener.dispose()
    }
    try {
      entry.process?.destroy()
    } catch (error) {
      console.warn('[daemon] Exited transient PTY disposal failed', error)
    }
  }

  private terminate(id: string, entry: Entry): void {
    const proc = entry.process
    if (!proc || entry.ended) {
      return
    }
    entry.terminationAttempts++
    try {
      if (process.platform === 'win32') {
        if (proc.terminateOwnedTree?.() !== 'terminated') {
          throw new Error('Transient PTY job termination is unavailable')
        }
      } else {
        forceKillPosixPtyProcessGroups(proc.pid, () => proc.kill('SIGKILL'))
      }
    } catch (error) {
      console.warn('[daemon] Transient PTY termination failed', error)
    }
    if (entry.ended) {
      return
    }
    if (entry.terminationAttempts < 3) {
      entry.timer = setTimeout(() => this.terminate(id, entry), 1_000)
    } else {
      // Keep ownership until onExit proves termination; failed signals must not free capacity.
      console.warn('[daemon] Transient PTY exit remains unverifiable', { id })
      this.publish(entry.owner, {
        type: 'event',
        event: 'terminalError',
        sessionId: id,
        payload: { message: 'Usage probe termination remains unverifiable' }
      })
    }
  }
}
