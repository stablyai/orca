import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import type { CodexEffectiveSkill } from '../../shared/skills'

type RpcResponse = { id?: number; result?: unknown; error?: { message?: string }; method?: string }
type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}
type SkillsListResponse = {
  data?: { cwd?: string; skills?: CodexEffectiveSkill[]; errors?: { message: string }[] }[]
}

export class CodexSkillInventoryService extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffers = new WeakMap<ChildProcessWithoutNullStreams, string>()
  private nextId = 0
  private initialized: Promise<void> | null = null
  private pending = new Map<number, PendingRequest>()

  constructor(private readonly codexHome?: string) {
    super()
  }

  async list(cwd: string, forceReload = false): Promise<CodexEffectiveSkill[]> {
    await this.ensureInitialized()
    const result = (await this.request('skills/list', {
      cwds: [cwd],
      forceReload
    })) as SkillsListResponse
    const entry = result.data?.find((candidate) => candidate.cwd === cwd) ?? result.data?.[0]
    if (!entry) {
      throw new Error(`Codex returned no skill inventory for ${cwd}.`)
    }
    if (entry.errors?.length) {
      throw new Error(entry.errors.map((error) => error.message).join('; '))
    }
    return entry.skills ?? []
  }

  dispose(): void {
    this.rejectPending(new Error('Codex skill inventory service stopped.'))
    this.child?.kill()
    this.child = null
    this.initialized = null
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return this.initialized
    }
    this.initialized = new Promise<void>((resolve, reject) => {
      const codexCommand = resolveCodexCommand()
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(codexCommand, ['app-server'])
      const child = spawn(spawnCmd, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) }
      })
      this.child = child
      this.buffers.set(child, '')
      // Why: app-server can emit diagnostics for the lifetime of the session;
      // leaving stderr unread can fill the pipe and deadlock skills/list.
      child.stderr.resume()
      child.stdout.on('data', (chunk: Buffer) => this.onData(child, chunk))
      child.on('error', (error) => this.onExit(child, error))
      child.on('close', () => this.onExit(child, new Error('Codex app-server exited.')))
      this.request('initialize', { clientInfo: { name: 'orca', version: '1.0.0' } })
        .then(() => {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`
          )
          resolve()
        })
        .catch((error) => {
          if (this.child === child) {
            this.child = null
            this.initialized = null
          }
          child.kill()
          reject(error)
        })
    })
    return this.initialized
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child
    if (!child) {
      return Promise.reject(new Error('Codex app-server is not running.'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}.`))
      }, 15_000)
      this.pending.set(id, { resolve, reject, timeout })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    let buffer = (this.buffers.get(child) ?? '') + chunk.toString()
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) {
        continue
      }
      let message: RpcResponse
      try {
        message = JSON.parse(line) as RpcResponse
      } catch {
        continue
      }
      if (message.method === 'skills/changed') {
        this.emit('changed')
        continue
      }
      if (message.id == null) {
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) {
        continue
      }
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Codex RPC failed.'))
      } else {
        pending.resolve(message.result)
      }
    }
    this.buffers.set(child, buffer)
  }

  private onExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return
    }
    this.rejectPending(error)
    this.child = null
    this.initialized = null
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export class CodexSkillInventoryRegistry extends EventEmitter {
  private services = new Map<string, CodexSkillInventoryService>()

  list(cwd: string, forceReload = false, codexHome?: string): Promise<CodexEffectiveSkill[]> {
    const key = codexHome?.trim() || '<default>'
    let service = this.services.get(key)
    if (!service) {
      service = new CodexSkillInventoryService(codexHome?.trim() || undefined)
      service.on('changed', () => this.emit('changed'))
      this.services.set(key, service)
    }
    return service.list(cwd, forceReload)
  }
}

export const codexSkillInventory = new CodexSkillInventoryRegistry()
