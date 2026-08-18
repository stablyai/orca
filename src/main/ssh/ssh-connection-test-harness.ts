import { Socket } from 'node:net'
import { vi } from 'vitest'
import { createSystemCommandChannel, createSystemSshProcess } from './ssh-connection-test-fixtures'
import type { Mock } from 'vitest'
import type { SshConnection } from './ssh-connection'
import type { MockSystemCommandChannel, MockSystemSshProcess } from './ssh-connection-test-fixtures'
import type { SshResolvedConfig } from './ssh-config-parser'
import type { SystemSshBuildArgsOptions } from './system-ssh-args'
import type { SshTarget } from '../../shared/ssh-types'

export type MockSshClient = {
  setNoDelay: ReturnType<typeof vi.fn>
  _sock: Socket | undefined
  lastExecCommand?: string
  lastConnectConfig?: unknown
  exec: (cmd: string, cb: (err: Error | undefined, channel: unknown) => void) => void
  sftp: (cb: (err: Error | undefined, channel: unknown) => void) => void
}

export type Ssh2ModuleMock = {
  BaseAgent: new () => object
  Client: new () => MockSshClient
  createAgent: Mock<(...args: unknown[]) => unknown>
  utils: { parseKey: Mock<(...args: unknown[]) => unknown> }
}

export type SystemSshBinaryModuleMock = { findSystemSsh: typeof findSystemSshMock }

export type SystemFallbackModuleMock = {
  getOrcaControlSocketPath: typeof getOrcaControlSocketPathMock
  spawnSystemSsh: typeof spawnSystemSshMock
  spawnSystemSshCommand: typeof spawnSystemSshCommandMock
  downloadFileViaSystemSsh: typeof downloadFileViaSystemSshMock
  uploadDirectoryViaSystemSsh: typeof uploadDirectoryViaSystemSshMock
  uploadFileViaSystemSsh: typeof uploadFileViaSystemSshMock
  writeBufferViaSystemSsh: typeof writeBufferViaSystemSshMock
  writeFileViaSystemSsh: typeof writeFileViaSystemSshMock
}

export type ControlSocketModuleMock = {
  removeControlSocketPath: typeof removeControlSocketPathMock
}

export type SshConfigParserModuleMock = { resolveWithSshG: typeof resolveWithSshGMock }

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
  connectBehavior: 'ready' as 'ready' | 'error',
  connectErrorMessage: '',
  connectErrorCode: '',
  destroyErrorMessage: '',
  connectSequence: [] as ('ready' | Error)[],
  execBehavior: 'callback' as 'callback' | 'pending',
  sftpBehavior: 'callback' as 'callback' | 'pending',
  notifyClientCreated: undefined as (() => void) | undefined
}

export const findSystemSshMock = vi.fn<() => string | null>()
export const getOrcaControlSocketPathMock =
  vi.fn<(target: SshTarget, options?: SystemSshBuildArgsOptions) => string | null>()
export const removeControlSocketPathMock = vi.fn<(socketPath: string) => void>()
export const spawnSystemSshMock =
  vi.fn<(target: SshTarget, options?: SystemSshBuildArgsOptions) => MockSystemSshProcess>()
export const spawnSystemSshCommandMock =
  vi.fn<(target: SshTarget, command: string, options?: unknown) => MockSystemCommandChannel>()
export const downloadFileViaSystemSshMock = vi.fn<(...args: unknown[]) => Promise<void>>()
export const uploadDirectoryViaSystemSshMock = vi.fn<(...args: unknown[]) => Promise<void>>()
export const uploadFileViaSystemSshMock = vi.fn<(...args: unknown[]) => Promise<void>>()
export const writeBufferViaSystemSshMock = vi.fn<(...args: unknown[]) => Promise<void>>()
export const writeFileViaSystemSshMock = vi.fn<(...args: unknown[]) => Promise<void>>()
export const resolveWithSshGMock = vi
  .fn<(...args: unknown[]) => Promise<SshResolvedConfig | null>>()
  .mockResolvedValue(null)

export function emitSshEvent(event: string, ...args: unknown[]): void {
  for (const handler of eventHandlers?.get(event) ?? []) {
    handler(...args)
  }
}

export function nextSshClientCreation(): Promise<void> {
  return new Promise((resolve) => {
    ssh2Mock.notifyClientCreated = resolve
  })
}

export async function connectWithFakeTimers(conn: SshConnection): Promise<void> {
  const clientCreated = nextSshClientCreation()
  const connected = conn.connect()
  await clientCreated
  await vi.advanceTimersByTimeAsync(1)
  await connected
}

export async function advanceToNextSshClient(delayMs: number): Promise<void> {
  const clientCreated = nextSshClientCreation()
  await vi.advanceTimersByTimeAsync(delayMs)
  await clientCreated
  await vi.advanceTimersByTimeAsync(1)
}

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
    constructor() {
      clientInstances.push(this)
      ssh2Mock.notifyClientCreated?.()
      ssh2Mock.notifyClientCreated = undefined
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = eventHandlers?.get(event) ?? new Set<(...args: unknown[]) => void>()
      handlers.add(handler)
      eventHandlers?.set(event, handlers)
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      const handlers = eventHandlers?.get(event)
      handlers?.delete(handler)
      if (handlers?.size === 0) {
        eventHandlers.delete(event)
      }
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
        setTimeout(
          () => emitSshEvent('error', new Error('All configured authentication methods failed')),
          0
        )
        return
      }
      setTimeout(() => {
        const next = ssh2Mock.connectSequence.shift()
        if (next instanceof Error) {
          emitSshEvent('error', next)
          return
        }
        if (next === 'ready') {
          emitSshEvent('ready')
          return
        }
        if (ssh2Mock.connectBehavior === 'error') {
          const err = new Error(ssh2Mock.connectErrorMessage) as NodeJS.ErrnoException
          if (ssh2Mock.connectErrorCode) {
            err.code = ssh2Mock.connectErrorCode
          }
          emitSshEvent('error', err)
        } else {
          emitSshEvent('ready')
        }
      }, 0)
    }
    end() {}
    destroy() {
      if (!ssh2Mock.destroyErrorMessage) {
        return
      }
      if (eventHandlers?.has('error')) {
        emitSshEvent('error', new Error(ssh2Mock.destroyErrorMessage))
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

// Why: security-key transport selection scans the real ~/.ssh defaults, so a developer's own
// FIDO2 key would otherwise decide which transport these tests take.
export function createSystemSshBinaryModule(): SystemSshBinaryModuleMock {
  return { findSystemSsh: findSystemSshMock }
}

export function createSystemFallbackModule(): SystemFallbackModuleMock {
  return {
    getOrcaControlSocketPath: getOrcaControlSocketPathMock,
    spawnSystemSsh: spawnSystemSshMock,
    spawnSystemSshCommand: spawnSystemSshCommandMock,
    downloadFileViaSystemSsh: downloadFileViaSystemSshMock,
    uploadDirectoryViaSystemSsh: uploadDirectoryViaSystemSshMock,
    uploadFileViaSystemSsh: uploadFileViaSystemSshMock,
    writeBufferViaSystemSsh: writeBufferViaSystemSshMock,
    writeFileViaSystemSsh: writeFileViaSystemSshMock
  }
}

export function createControlSocketModule(): ControlSocketModuleMock {
  return { removeControlSocketPath: removeControlSocketPathMock }
}

export function createSshConfigParserModule(): SshConfigParserModuleMock {
  return { resolveWithSshG: resolveWithSshGMock }
}

export function resetSsh2ClientState(): void {
  eventHandlers = new Map()
  ssh2Mock.connectBehavior = 'ready'
  ssh2Mock.connectErrorMessage = ''
  ssh2Mock.connectSequence = []
  clientInstances = []
}

export function resetSshConnectionMocks(): void {
  resetSsh2ClientState()
  ssh2Mock.connectErrorCode = ''
  ssh2Mock.destroyErrorMessage = ''
  connectAttempts = 0
  ssh2Mock.execBehavior = 'callback'
  pendingExecCallback = null
  ssh2Mock.sftpBehavior = 'callback'
  pendingSftpCallback = null
  ssh2Mock.notifyClientCreated = undefined
  ssh2Mock.presentedHostKey = undefined
  ssh2Mock.lastHostKeyAccepted = undefined
  getOrcaControlSocketPathMock.mockReset()
  getOrcaControlSocketPathMock.mockReturnValue(null)
  removeControlSocketPathMock.mockReset()
  spawnSystemSshMock.mockReset()
  spawnSystemSshMock.mockImplementation(() => createSystemSshProcess())
  spawnSystemSshCommandMock.mockReset()
  spawnSystemSshCommandMock.mockImplementation(() => createSystemCommandChannel())
  downloadFileViaSystemSshMock.mockReset()
  downloadFileViaSystemSshMock.mockResolvedValue(undefined)
  uploadDirectoryViaSystemSshMock.mockReset()
  uploadDirectoryViaSystemSshMock.mockResolvedValue(undefined)
  uploadFileViaSystemSshMock.mockReset()
  uploadFileViaSystemSshMock.mockResolvedValue(undefined)
  writeBufferViaSystemSshMock.mockReset()
  writeBufferViaSystemSshMock.mockResolvedValue(undefined)
  writeFileViaSystemSshMock.mockReset()
  writeFileViaSystemSshMock.mockResolvedValue(undefined)
  resolveWithSshGMock.mockReset()
  resolveWithSshGMock.mockResolvedValue(null)
  findSystemSshMock.mockReset()
  findSystemSshMock.mockReturnValue(null)
  vi.unstubAllEnvs()
}
