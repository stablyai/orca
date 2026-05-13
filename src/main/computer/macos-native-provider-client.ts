/* eslint-disable max-lines -- Why: the macOS provider transport owns one lifecycle across stdio fallback and helper-app socket mode. */
import { spawn } from 'child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import type net from 'net'
import { release, tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from '../../shared/runtime-types'
import {
  assertMacOSProviderCapability,
  REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION,
  type NativeActionMethod,
  type NativeMethod,
  type NativeResponse,
  type PendingNativeRequest,
  writeNativeProviderLine
} from './macos-native-provider-contract'
import { resolveMacOSComputerUseExecutablePath } from './macos-native-provider-paths'
import { connectMacOSProviderSocket } from './macos-native-provider-socket'
import { RuntimeClientError } from './runtime-client-error'

const REQUEST_TIMEOUT_MS = 60_000
const HELPER_CONNECT_TIMEOUT_MS = 10_000

export function shouldUseMacOSNativeProvider(): boolean {
  return (
    process.platform === 'darwin' &&
    isMacOS14OrNewer() &&
    resolveMacOSComputerUseExecutablePath() !== null
  )
}

export class MacOSNativeProviderClient {
  private socket: net.Socket | null = null
  private socketStartPromise: Promise<net.Socket> | null = null
  private socketPath: string | null = null
  private socketDirectory: string | null = null
  private socketTokenPath: string | null = null
  private socketToken: string | null = null
  private nextId = 1
  private pending = new Map<number, PendingNativeRequest>()
  private socketBuffer = ''
  private providerCapabilities: ComputerProviderCapabilities | null = null
  async listApps(): Promise<ComputerListAppsResult> {
    return (await this.call('listApps', {})) as ComputerListAppsResult
  }
  async capabilities(): Promise<ComputerProviderCapabilities> {
    await this.ensureCompatible()
    return this.providerCapabilities!
  }
  async listWindows(params: unknown): Promise<ComputerListWindowsResult> {
    await this.ensureCapability('windows', 'list')
    return (await this.call('listWindows', params)) as ComputerListWindowsResult
  }
  async snapshot(params: unknown): Promise<ComputerSnapshotResult> {
    return (await this.call('getAppState', params)) as ComputerSnapshotResult
  }
  async action(method: NativeActionMethod, params: unknown): Promise<ComputerActionResult> {
    return (await this.call(method, params)) as ComputerActionResult
  }
  shutdown(): void {
    const socket = this.socket
    const token = this.socketToken
    this.socket = null
    this.socketStartPromise = null
    this.providerCapabilities = null
    if (socket && !socket.destroyed) {
      const id = this.nextId++
      socket.write(`${JSON.stringify({ id, method: 'terminate', params: {}, token })}\n`)
      socket.end()
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(
        new RuntimeClientError('accessibility_error', 'native macOS provider shut down')
      )
      this.pending.delete(id)
    }
    this.cleanupSocketDirectory()
  }
  private async call(method: NativeMethod, params: unknown): Promise<unknown> {
    if (method !== 'handshake') {
      await this.ensureCompatible()
    }
    return await this.send(method, params)
  }
  private async send(method: NativeMethod, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const helperExecutablePath = resolveMacOSComputerUseExecutablePath()
    if (!helperExecutablePath) {
      throw new RuntimeClientError('accessibility_error', 'Orca Computer Use.app was not found')
    }
    const transport = await this.ensureSocketStarted(helperExecutablePath)
    const token = this.socketToken
    const line = `${JSON.stringify({ id, method, params, token })}\n`
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.shutdown()
        reject(
          new RuntimeClientError('action_timeout', `native macOS provider ${method} timed out`)
        )
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      await writeNativeProviderLine(transport, line)
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
      }
      throw new RuntimeClientError(
        'accessibility_error',
        error instanceof Error ? error.message : String(error)
      )
    }
    return await result
  }
  private async ensureCompatible(): Promise<void> {
    if (this.providerCapabilities) {
      return
    }
    const capabilities = await this.readCapabilities()
    if (capabilities.protocolVersion === REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION) {
      this.providerCapabilities = capabilities
      return
    }
    this.shutdown()
    const restarted = await this.readCapabilities()
    if (restarted.protocolVersion !== REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION) {
      throw new RuntimeClientError(
        'provider_incompatible',
        `native macOS provider protocol ${restarted.protocolVersion} is incompatible with required protocol ${REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION}`
      )
    }
    this.providerCapabilities = restarted
  }
  private async readCapabilities(): Promise<ComputerProviderCapabilities> {
    return (await this.send('handshake', {})) as ComputerProviderCapabilities
  }
  private async ensureCapability(
    group: keyof ComputerProviderCapabilities['supports'],
    capability: string
  ): Promise<void> {
    await this.ensureCompatible()
    if (assertMacOSProviderCapability(this.providerCapabilities, group, capability)) {
      return
    }
    throw new RuntimeClientError(
      'unsupported_capability',
      `native macOS provider does not support ${String(group)}.${capability}`
    )
  }
  private async ensureSocketStarted(helperExecutablePath: string): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket
    }
    if (this.socketStartPromise) {
      return await this.socketStartPromise
    }
    this.socketStartPromise = this.startSocket(helperExecutablePath)
    try {
      return await this.socketStartPromise
    } finally {
      this.socketStartPromise = null
    }
  }
  private async startSocket(helperExecutablePath: string): Promise<net.Socket> {
    this.socketDirectory = mkdtempSync(join(tmpdir(), 'orca-computer-use-'))
    chmodSync(this.socketDirectory, 0o700)
    this.socketPath = join(this.socketDirectory, 'provider.sock')
    this.socketToken = randomUUID()
    this.socketTokenPath = join(this.socketDirectory, 'provider.token')
    writeFileSync(this.socketTokenPath, this.socketToken, { encoding: 'utf8', mode: 0o600 })
    // Why: launching the nested helper via LaunchServices can make TCC evaluate
    // Orca.app as responsible; the signed helper executable owns this grant.
    const provider = spawn(
      helperExecutablePath,
      ['--agent', this.socketPath, '--token-file', this.socketTokenPath],
      { detached: true, stdio: 'ignore' }
    )
    provider.unref()
    try {
      const socket = await connectMacOSProviderSocket(this.socketPath, HELPER_CONNECT_TIMEOUT_MS)
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => this.handleSocketData(chunk))
      socket.on('close', () => this.handleSocketClose())
      socket.on('error', (error) => this.handleTransportError(error))
      this.socket = socket
      return socket
    } catch (error) {
      this.cleanupSocketDirectory()
      this.socketPath = null
      this.socketTokenPath = null
      this.socketToken = null
      throw error
    }
  }
  private handleSocketData(chunk: string): void {
    this.socketBuffer += chunk
    this.socketBuffer = this.consumeLines(this.socketBuffer)
  }
  private consumeLines(buffer: string): string {
    let remaining = buffer
    while (true) {
      const newline = remaining.indexOf('\n')
      if (newline < 0) {
        return remaining
      }
      const line = remaining.slice(0, newline)
      remaining = remaining.slice(newline + 1)
      if (line.trim()) {
        this.handleLine(line)
      }
    }
  }
  private handleLine(line: string): void {
    let response: NativeResponse
    try {
      response = JSON.parse(line) as NativeResponse
    } catch {
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    if (response.ok) {
      pending.resolve(response.result)
      return
    }
    pending.reject(new RuntimeClientError(response.error.code, response.error.message))
  }
  private handleSocketClose(): void {
    this.socket = null
    this.cleanupSocketDirectory()
    this.rejectPending(
      new RuntimeClientError('accessibility_error', 'native macOS helper app connection closed')
    )
  }
  private handleTransportError(error: Error): void {
    this.rejectPending(new RuntimeClientError('accessibility_error', error.message))
  }
  private cleanupSocketDirectory(): void {
    if (!this.socketDirectory) {
      return
    }
    rmSync(this.socketDirectory, { recursive: true, force: true })
    this.socketDirectory = null
    this.socketPath = null
    this.socketTokenPath = null
  }
  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

function isMacOS14OrNewer(): boolean {
  const darwinMajor = Number.parseInt(release().split('.')[0] ?? '', 10)
  return Number.isFinite(darwinMajor) && darwinMajor >= 23
}
