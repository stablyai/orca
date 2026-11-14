import '../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { TerminalHost } from '../../terminal-host/terminal-host'
import type { TerminalHostOptions } from '../../terminal-host/terminal-host-options'
import { TerminalSpawnGate } from '../terminal-spawn-gate'
import type { TerminalSpawnAdmissionMode } from '../terminal-spawn-admission-mode'

import { HostTerminalLedger } from '../host-terminal-ledger'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

function stream() {
  return { onData: vi.fn(), onExit: vi.fn() }
}

describe('TerminalSpawnGate', () => {
  let host: TerminalHost
  let gate: TerminalSpawnGate
  let log: Mock<(event: string, details: Record<string, unknown>) => void>
  let exits: Map<number, (code: number) => void>
  let spawnSubprocess: Mock<SpawnSubprocess>
  let nextPid: number
  let now: number

  beforeEach(() => {
    exits = new Map()
    nextPid = 1000
    now = 0
    log = vi.fn()
    gate = new TerminalSpawnGate({ log, now: () => now })

    spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
      const pid = nextPid++
      const handle: SubprocessHandle = {
        pid,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => exits.get(pid)?.(0)),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => exits.get(pid)?.(137)),
        signal: vi.fn(),
        onData: vi.fn(),
        onExit: (callback) => {
          exits.set(pid, callback)
        },
        dispose: vi.fn()
      }
      return handle
    })
    host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await host.dispose()
  })

  describe('host terminal cap', () => {
    function capAt(maxTerminals: number, mode: TerminalSpawnAdmissionMode = 'observe') {
      gate = new TerminalSpawnGate({
        log,
        mode,
        now: () => now,
        hostTerminals: new HostTerminalLedger({ dir: null, maxTerminals, log })
      })
      host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
    }
    const shell = (sessionId: string) =>
      host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient: stream() })

    it('frees a slot when a terminal exits, and never charges an attach', async () => {
      capAt(1)
      await shell('a')
      await expect(
        host.createOrAttach({
          sessionId: 'a',
          cols: 80,
          rows: 24,
          attachOnly: true,
          streamClient: stream()
        })
      ).resolves.toMatchObject({ isNew: false })
      exits.get(1000)?.(0)
      await expect(shell('b')).resolves.toMatchObject({ isNew: true })
    })

    it('frees the slot of a fork that failed', async () => {
      capAt(1)
      spawnSubprocess.mockImplementationOnce((options) => {
        options.onCreationDisposition?.({ kind: 'no-fork' })
        throw new Error('spawn failed')
      })
      await expect(shell('a')).rejects.toThrow('spawn failed')
      await expect(shell('b')).resolves.toMatchObject({ isNew: true })
    })
  })
})
