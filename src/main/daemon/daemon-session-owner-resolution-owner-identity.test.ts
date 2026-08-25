import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { TerminalOwnerIdentity } from '../../shared/terminal-owner-identity'

const ownerA: TerminalOwnerIdentity = {
  executionHostId: 'local',
  ownerKind: 'daemon',
  ownerIncarnationId: 'daemon-a',
  sessionIncarnationId: 'session-a',
  protocolVersion: 37,
  endpointRef: 'local-daemon'
}

function provider(processes: PtyProcessInfo[]): IPtyProvider {
  return {
    listProcesses: vi.fn(async () => processes),
    spawn: vi.fn(),
    attach: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(async () => {}),
    sendSignal: vi.fn(async () => {}),
    getCwd: vi.fn(async () => ''),
    getInitialCwd: vi.fn(async () => ''),
    clearBuffer: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    serialize: vi.fn(async () => ''),
    revive: vi.fn(async () => {}),
    getDefaultShell: vi.fn(async () => ''),
    getProfiles: vi.fn(async () => []),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  }
}

describe('daemon owner identity resolution', () => {
  it('rejects a compatible replacement with the same logical id', async () => {
    const replacement = provider([
      {
        id: 'pty-1',
        incarnationId: 'session-b',
        ownerIdentity: {
          ...ownerA,
          ownerIncarnationId: 'daemon-b',
          sessionIncarnationId: 'session-b'
        },
        cwd: '',
        title: 'shell'
      }
    ])
    const resolver = new DaemonSessionOwnerResolver([replacement], new Map())
    await expect(
      resolver.resolve('pty-1', ownerA.sessionIncarnationId, true, ownerA)
    ).resolves.toEqual({
      kind: 'unknown'
    })
  })
})
