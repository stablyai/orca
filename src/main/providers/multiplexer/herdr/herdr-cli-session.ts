import { spawn } from 'node:child_process'
import type { HerdrApiSchema, HerdrResponse } from './herdr-runtime-contract'
import type { HerdrCommand } from './herdr-command'
import {
  assertHerdrSchemaCompatible,
  assertHerdrServerCompatible,
  HerdrRuntimeError,
  unwrapHerdrResponse
} from './herdr-runtime-contract'
import { herdrServerEnvironment, parseHerdrSessionList } from './herdr-session-process'
import { herdrStockCliInvocation } from './herdr-stock-cli-request'

export type HerdrCliSessionOptions = {
  commandFor: (herdrArgs: string[]) => HerdrCommand
  serverCommandFor?: (sessionName: string) => HerdrCommand
  timeoutMs?: number
}

export class HerdrCliSessionManager {
  private readonly options: HerdrCliSessionOptions
  private readonly sessionPromises = new Map<string, Promise<void>>()
  private schema: HerdrApiSchema | null = null

  constructor(options: HerdrCliSessionOptions) {
    this.options = options
  }

  async ensureSession(sessionName: string): Promise<void> {
    const existing = this.sessionPromises.get(sessionName)
    if (existing) {
      return await existing
    }
    const pending = this.ensureSessionInner(sessionName)
    this.sessionPromises.set(sessionName, pending)
    try {
      await pending
    } finally {
      if (this.sessionPromises.get(sessionName) === pending) {
        this.sessionPromises.delete(sessionName)
      }
    }
  }

  private async ensureSessionInner(sessionName: string): Promise<void> {
    const schema = await this.loadSchema()
    const sessions = await this.listSessions()
    if (!sessions.some((session) => session.name === sessionName && session.running)) {
      await this.startServer(sessionName)
      await this.waitForSession(sessionName)
    }
    const invocation = herdrStockCliInvocation(sessionName, 'session.snapshot', {})
    const response = invocation.parse(await this.run(invocation.args)) as HerdrResponse<{
      snapshot: { protocol: number }
    }>
    assertHerdrServerCompatible(schema, unwrapHerdrResponse(response).snapshot.protocol)
  }

  private async loadSchema(): Promise<HerdrApiSchema> {
    if (!this.schema) {
      const schema = JSON.parse(await this.run(['api', 'schema', '--json'])) as HerdrApiSchema
      assertHerdrSchemaCompatible(schema)
      this.schema = schema
    }
    return this.schema
  }

  private async listSessions(): Promise<{ name: string; running: boolean }[]> {
    return parseHerdrSessionList(await this.run(['session', 'list', '--json']))
  }

  private async startServer(sessionName: string): Promise<void> {
    const command =
      this.options.serverCommandFor?.(sessionName) ??
      (() => {
        const base = this.options.commandFor(['--session', sessionName, 'server'])
        return {
          ...base,
          env: herdrServerEnvironment(base.env)
        }
      })()
    const child = spawn(command.file, command.args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      ...(command.env ? { env: command.env } : {})
    })
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(started)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const started = setTimeout(() => {
        child.unref()
        finish()
      }, 100)
      child.once('error', (error) => finish(error))
      child.once('close', (code) => {
        finish(new Error(`Herdr server exited during startup with code ${code ?? 'unknown'}`))
      })
    })
  }

  private async waitForSession(sessionName: string): Promise<void> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 15_000)
    while (Date.now() < deadline) {
      const sessions = await this.listSessions().catch(() => [])
      if (sessions.some((session) => session.name === sessionName && session.running)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new HerdrRuntimeError(
      'herdr_unavailable',
      `Herdr session ${sessionName} did not start within ${this.options.timeoutMs ?? 15_000}ms`
    )
  }

  private async runCli(args: string[], input?: string): Promise<string> {
    const command = this.options.commandFor(args)
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(command.env ? { env: command.env } : {})
      })
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error(`Herdr command timed out after ${this.options.timeoutMs ?? 15_000}ms`))
      }, this.options.timeoutMs ?? 15_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (stdout += chunk))
      child.stderr.on('data', (chunk: string) => (stderr += chunk))
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(stderr.trim() || `Herdr exited with code ${code ?? 'unknown'}`))
        }
      })
      child.stdin.end(input)
    })
  }

  async run(args: string[]): Promise<string> {
    return await this.runCli(args)
  }
}
