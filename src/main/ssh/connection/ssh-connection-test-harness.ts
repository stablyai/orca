import { vi } from 'vitest'
import { createSystemCommandChannel, createSystemSshProcess } from './ssh-connection-test-fixtures'
import type { SshConnection } from './ssh-connection'
import type { MockSystemCommandChannel, MockSystemSshProcess } from './ssh-connection-test-fixtures'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import type { SystemSshBuildArgsOptions } from '../system-transport/system-ssh-args'
import type { SshTarget } from '../../../shared/ssh-types'
import type * as SystemSshArgs from '../system-transport/system-ssh-args'
import type * as SystemSshCommand from '../system-transport/system-ssh-command'
import type * as SystemSshFileBinaryTransfer from '../system-transport/system-ssh-file-binary-transfer'
import type * as SystemSshFileTransfer from '../system-transport/system-ssh-file-transfer'
import type * as SshGConfigResolution from '../config/ssh-g-config-resolution'
import { resetSsh2ClientState, ssh2Mock } from '../__tests__/ssh-connection-test-client'

export type SystemSshBinaryModuleMock = { findSystemSsh: typeof findSystemSshMock }

export type ControlSocketModuleMock = {
  removeControlSocketPath: typeof removeControlSocketPathMock
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

// Keep developer FIDO2 keys from deciding transport selection.
export function createSystemSshBinaryModule(): SystemSshBinaryModuleMock {
  return { findSystemSsh: findSystemSshMock }
}

// The system-ssh seams SshConnection reaches, each layered over its module's real exports.
export function withSystemSshArgsMocks(actual: typeof SystemSshArgs) {
  return { ...actual, getOrcaControlSocketPath: getOrcaControlSocketPathMock }
}

export function withSystemSshCommandMocks(actual: typeof SystemSshCommand) {
  return {
    ...actual,
    spawnSystemSsh: spawnSystemSshMock,
    spawnSystemSshCommand: spawnSystemSshCommandMock
  }
}

export function withSystemSshFileBinaryTransferMocks(actual: typeof SystemSshFileBinaryTransfer) {
  return {
    ...actual,
    downloadFileViaSystemSsh: downloadFileViaSystemSshMock,
    uploadFileViaSystemSsh: uploadFileViaSystemSshMock,
    writeBufferViaSystemSsh: writeBufferViaSystemSshMock
  }
}

export function withSystemSshFileTransferMocks(actual: typeof SystemSshFileTransfer) {
  return {
    ...actual,
    uploadDirectoryViaSystemSsh: uploadDirectoryViaSystemSshMock,
    writeFileViaSystemSsh: writeFileViaSystemSshMock
  }
}

export function createControlSocketModule(): ControlSocketModuleMock {
  return { removeControlSocketPath: removeControlSocketPathMock }
}

// Unreadable config isolates alias claims from the developer's ~/.ssh/config.
export function createSshConfigParserModule(): Record<string, never> {
  return {}
}

export function withSshGConfigResolutionMocks(actual: typeof SshGConfigResolution) {
  return { ...actual, resolveWithSshG: resolveWithSshGMock }
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
