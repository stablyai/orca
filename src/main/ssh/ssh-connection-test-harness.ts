import { vi } from 'vitest'
import { createSystemCommandChannel, createSystemSshProcess } from './ssh-connection-test-fixtures'
import type { SshConnection } from './ssh-connection'
import type { MockSystemCommandChannel, MockSystemSshProcess } from './ssh-connection-test-fixtures'
import type { SshResolvedConfig } from './ssh-config-parser'
import type { SystemSshBuildArgsOptions } from './system-ssh-args'
import type { SshTarget } from '../../shared/ssh-types'
import { resetSsh2ClientState, ssh2Mock } from './__tests__/ssh-connection-test-client'
export {
  clientInstances,
  connectAttempts,
  createSsh2Module,
  emitSshEvent,
  eventHandlers,
  pendingExecCallback,
  pendingSftpCallback,
  resetSsh2ClientState,
  ssh2Mock,
  VALID_ED25519_HOST_KEY
} from './__tests__/ssh-connection-test-client'
export type { MockSshClient, Ssh2ModuleMock } from './__tests__/ssh-connection-test-client'

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

export function resetSshConnectionMocks(): void {
  resetSsh2ClientState()
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
