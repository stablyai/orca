import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from '../../../ssh/ssh-connection'
import { shellEscape } from '../../../ssh/ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from '../../../ssh/ssh-remote-powershell'
import type { RemoteHostPlatform } from '../../../ssh/ssh-remote-platform'
import type { HerdrApiSchema, HerdrResponse } from './herdr-runtime-contract'
import {
  assertHerdrSchemaCompatible,
  assertHerdrServerCompatible,
  HerdrRuntimeError,
  unwrapHerdrResponse
} from './herdr-runtime-contract'
import { parseHerdrSessionList, type HerdrListedSession } from './herdr-session-process'
import { herdrStockCliInvocation } from './herdr-stock-cli-request'

export type HerdrSshSessionOptions = {
  connection: SshConnection
  timeoutMs?: number
  resolveExecutable: () => Promise<string>
  hostPlatform?: RemoteHostPlatform
}

export class HerdrSshSessionManager {
  private executablePromise: Promise<string> | null = null
  private readonly sessionPromises = new Map<string, Promise<void>>()
  private schema: HerdrApiSchema | null = null

  constructor(
    private readonly connection: SshConnection,
    private readonly timeoutMs = 15_000,
    private readonly resolveExecutable: () => Promise<string> = async () => 'herdr',
    private readonly hostPlatform?: RemoteHostPlatform
  ) {}

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

  private async listSessions(): Promise<HerdrListedSession[]> {
    return parseHerdrSessionList(await this.run(['session', 'list', '--json']))
  }

  private async startServer(sessionName: string): Promise<void> {
    const executable = await this.executable()
    if (this.hostPlatform?.commandDialect === 'powershell') {
      const script = [
        `Start-Process -FilePath ${powerShellLiteral(executable)} -ArgumentList @(${powerShellLiteral(`--session ${sessionName} server`)}) -WindowStyle Hidden`
      ].join('; ')
      const channel = await this.connection.exec(powerShellCommand(script), {
        wrapCommand: false
      })
      channel.end()
      return
    }
    const command = [
      'nohup',
      shellEscape(executable),
      '--session',
      shellEscape(sessionName),
      'server',
      '</dev/null',
      '>/dev/null',
      '2>&1',
      '&'
    ].join(' ')
    const channel = await this.connection.exec(command)
    channel.end()
  }

  private async waitForSession(sessionName: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      const sessions = await this.listSessions().catch(() => [])
      if (sessions.some((session) => session.name === sessionName && session.running)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new HerdrRuntimeError(
      'herdr_unavailable',
      `Remote Herdr session ${sessionName} did not start within ${this.timeoutMs}ms`
    )
  }

  private async executable(): Promise<string> {
    this.executablePromise ??= this.resolveExecutable().catch((error: unknown) => {
      this.executablePromise = null
      throw error
    })
    return await this.executablePromise
  }

  private async command(args: string[]): Promise<string> {
    const executable = await this.executable()
    if (this.hostPlatform?.commandDialect === 'powershell') {
      return powerShellCommand(`& ${[executable, ...args].map(powerShellLiteral).join(' ')}`)
    }
    return [executable, ...args].map(shellEscape).join(' ')
  }

  async open(args: string[]): Promise<ClientChannel> {
    return await this.connection.exec(await this.command(args), {
      wrapCommand: this.hostPlatform?.commandDialect !== 'powershell'
    })
  }

  async run(args: string[]): Promise<string> {
    const channel = await this.open(args)
    return await new Promise((resolve, reject) => {
      const stdoutDecoder = new StringDecoder('utf8')
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        channel.close()
        reject(new Error(`Remote Herdr command timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      channel.on('data', (chunk: Buffer) => (stdout += stdoutDecoder.write(chunk)))
      channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      channel.once('error', (error: Error) => {
        clearTimeout(timeout)
        reject(error)
      })
      channel.once('close', (code: number) => {
        clearTimeout(timeout)
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(stderr.trim() || `Remote Herdr exited with code ${code}`))
        }
      })
      channel.end()
    })
  }
}
