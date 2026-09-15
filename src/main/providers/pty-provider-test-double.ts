import { vi, type Mock } from 'vitest'
import { settledWriteStub } from './settled-pty-write-stub'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'

export type PtyProviderTestDouble = IPtyProvider & {
  spawn: Mock<(opts: PtySpawnOptions) => Promise<PtySpawnResult>>
}

export function createPtyProviderTestDouble(id: string): PtyProviderTestDouble {
  return {
    spawn: vi.fn(async () => ({ id })),
    attach: vi.fn(async () => {}),
    write: vi.fn(),
    writeWithSettlement: vi.fn(settledWriteStub()),
    resize: vi.fn(),
    shutdown: vi.fn(async () => {}),
    sendSignal: vi.fn(async () => {}),
    getCwd: vi.fn(async () => ''),
    getInitialCwd: vi.fn(async () => ''),
    clearBuffer: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    serialize: vi.fn(async () => '{}'),
    revive: vi.fn(async () => {}),
    listProcesses: vi.fn(async () => []),
    getDefaultShell: vi.fn(async () => '/bin/zsh'),
    getProfiles: vi.fn(async () => []),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  }
}
