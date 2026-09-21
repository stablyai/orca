import { Socket } from 'node:net'
import { vi } from 'vitest'
import type { Mock } from 'vitest'

export type MockSshClient = {
  setNoDelay: ReturnType<typeof vi.fn>
  _sock: Socket | undefined
  lastExecCommand?: string
  lastConnectConfig?: unknown
  on: (event: string, handler: (...args: unknown[]) => void) => void
  off: (event: string, handler: (...args: unknown[]) => void) => void
  connect: (config?: unknown) => void
  destroy: () => void
  emit: (event: string, ...args: unknown[]) => void
  clearPendingTimers: () => void
  exec: (cmd: string, cb: (err: Error | undefined, channel: unknown) => void) => void
  sftp: (cb: (err: Error | undefined, channel: unknown) => void) => void
}

export type Ssh2ModuleMock = {
  BaseAgent: new () => object
  Client: new () => MockSshClient
  createAgent: Mock<(...args: unknown[]) => unknown>
  utils: { parseKey: Mock<(...args: unknown[]) => unknown> }
}

// Read-only from tests: live ESM bindings so importers observe the mock's writes.
export let eventHandlers = new Map<string, Set<(...args: unknown[]) => void>>()
export let clientInstances: MockSshClient[] = []
export let connectAttempts = 0
export let pendingExecCallback: ((err: Error | undefined, channel: unknown) => void) | null = null
export let pendingSftpCallback: ((err: Error | undefined, channel: unknown) => void) | null = null

/** Lets a test present a real key blob instead of the placeholder. */
export const VALID_ED25519_HOST_KEY = Buffer.from(
  'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  'base64'
)

// Knobs tests assign to; grouped because imported bindings cannot be reassigned.
export const ssh2Mock = {
  presentedHostKey: undefined as Buffer | undefined,
  /** What the verifier decided about the presented key on the most recent connect. */
  lastHostKeyAccepted: undefined as boolean | undefined,
  connectBehavior: 'ready' as 'ready' | 'error' | 'pending',
  connectErrorMessage: '',
  connectErrorCode: '',
  destroyErrorMessage: '',
  connectSequence: [] as ('ready' | Error)[],
  execBehavior: 'callback' as 'callback' | 'pending',
  sftpBehavior: 'callback' as 'callback' | 'pending',
  notifyClientCreated: undefined as (() => void) | undefined
}

export const emitSshEvent = (event: string, ...args: unknown[]): void =>
  clientInstances.at(-1)?.emit(event, ...args)

export function createSsh2Module(): Ssh2ModuleMock {
  class MockBaseAgent {}
  class MockSshClient {
    setNoDelay = vi.fn()
    // Why: production code reads `client._sock` and checks `instanceof net.Socket`
    // to decide which log line to emit. A real Socket instance lets the test
    // exercise the "enabled" branch instead of the "skipped (proxy socket)" branch.
    _sock: Socket | undefined = new Socket()
    lastExecCommand?: string
    lastConnectConfig?: unknown
    private handlers = new Map<string, Set<(...args: unknown[]) => void>>()
    private connectTimer: ReturnType<typeof setTimeout> | null = null
    private handshakeTimer: ReturnType<typeof setTimeout> | null = null
    constructor() {
      clientInstances.push(this)
      eventHandlers = this.handlers
      ssh2Mock.notifyClientCreated?.()
      ssh2Mock.notifyClientCreated = undefined
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>()
      handlers.add(handler)
      this.handlers.set(event, handlers)
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event)
      handlers?.delete(handler)
      if (handlers?.size === 0) {
        this.handlers.delete(event)
      }
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args)
      }
    }
    clearPendingTimers() {
      if (this.connectTimer) {
        clearTimeout(this.connectTimer)
      }
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer)
      }
      this.connectTimer = this.handshakeTimer = null
    }
    connect(config?: unknown) {
      connectAttempts += 1
      this.lastConnectConfig = config
      // Why the callback form: ssh2 calls hostVerifier(key, verify) and only accepts synchronously
      // when the return is not undefined. A mock that passed one argument and ignored the result
      // would pass against a verifier that never decides — which is the regression host key
      // verification exists to prevent.
      const hostVerifier = (
        config as
          | { hostVerifier?: (key: Buffer, verify: (ok: boolean) => void) => undefined }
          | undefined
      )?.hostVerifier
      const presentedHostKey = ssh2Mock.presentedHostKey ?? VALID_ED25519_HOST_KEY
      ssh2Mock.lastHostKeyAccepted = undefined
      hostVerifier?.(presentedHostKey, (ok) => {
        ssh2Mock.lastHostKeyAccepted = ok
      })
      if (ssh2Mock.lastHostKeyAccepted === false) {
        // ssh2 aborts the handshake when the verifier denies; a mock that carried on to 'ready'
        // would let a rejected host key look like a successful connect.
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null
          this.emit('error', new Error('All configured authentication methods failed'))
        }, 0)
        return
      }
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null
        const next = ssh2Mock.connectSequence.shift()
        if (next instanceof Error) {
          this.emit('error', next)
          return
        }
        if (next === 'ready') {
          this.emit('ready')
          return
        }
        if (ssh2Mock.connectBehavior === 'pending') {
          const configValue = this.lastConnectConfig
          const readyTimeout =
            configValue &&
            typeof configValue === 'object' &&
            'readyTimeout' in configValue &&
            typeof configValue.readyTimeout === 'number'
              ? configValue.readyTimeout
              : undefined
          if (readyTimeout && readyTimeout > 0) {
            this.handshakeTimer = setTimeout(() => {
              this.handshakeTimer = null
              this.emit('error', new Error('Timed out while waiting for handshake'))
            }, readyTimeout)
          }
          return
        }
        if (ssh2Mock.connectBehavior === 'error') {
          const err = new Error(ssh2Mock.connectErrorMessage) as NodeJS.ErrnoException
          if (ssh2Mock.connectErrorCode) {
            err.code = ssh2Mock.connectErrorCode
          }
          this.emit('error', err)
        } else {
          this.emit('ready')
        }
      }, 0)
    }
    end() {
      this.clearPendingTimers()
    }
    destroy() {
      this.clearPendingTimers()
      if (!ssh2Mock.destroyErrorMessage) {
        this.emit('close')
        return
      }
      if (this.handlers.has('error')) {
        this.emit('error', new Error(ssh2Mock.destroyErrorMessage))
        return
      }
      throw new Error(ssh2Mock.destroyErrorMessage)
    }
    exec(cmd: string, cb: (err: Error | undefined, channel: unknown) => void) {
      this.lastExecCommand = cmd
      if (ssh2Mock.execBehavior === 'pending') {
        pendingExecCallback = cb
        return
      }
      cb(undefined, { close: vi.fn() })
    }
    sftp(cb: (err: Error | undefined, channel: unknown) => void) {
      if (ssh2Mock.sftpBehavior === 'pending') {
        pendingSftpCallback = cb
        return
      }
      cb(undefined, { end: vi.fn() })
    }
  }
  return {
    BaseAgent: MockBaseAgent,
    Client: MockSshClient,
    createAgent: vi.fn(),
    utils: {
      parseKey: vi.fn()
    }
  }
}

export function resetSsh2ClientState(): void {
  for (const client of clientInstances) {
    client.clearPendingTimers()
  }
  eventHandlers = new Map()
  connectAttempts = 0
  pendingExecCallback = null
  pendingSftpCallback = null
  ssh2Mock.connectBehavior = 'ready'
  ssh2Mock.connectErrorMessage = ''
  ssh2Mock.connectErrorCode = ''
  ssh2Mock.destroyErrorMessage = ''
  ssh2Mock.connectSequence = []
  ssh2Mock.execBehavior = 'callback'
  ssh2Mock.sftpBehavior = 'callback'
  ssh2Mock.notifyClientCreated = undefined
  ssh2Mock.presentedHostKey = undefined
  ssh2Mock.lastHostKeyAccepted = undefined
  clientInstances = []
}
