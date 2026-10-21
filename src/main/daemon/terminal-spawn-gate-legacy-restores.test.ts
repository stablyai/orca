import './mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostPressureLevel, SpawnIntent } from '../../shared/host-spawn-admission'
import { HostTerminalLedger } from './host-terminal-ledger'
import { LegacyRestoreRecords } from './legacy-restore-records'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'
import { TerminalSpawnGate } from './terminal-spawn-gate'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

describe('the host records the legacy restores it refuses', () => {
  let dir: string
  let records: LegacyRestoreRecords
  let pressure: HostPressureLevel
  let host: TerminalHost
  let nextPid: number

  function build(maxTerminals = 256): void {
    const spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
      let onExit: ((code: number) => void) | undefined
      const handle: SubprocessHandle = {
        pid: nextPid++,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => onExit?.(0)),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => onExit?.(137)),
        signal: vi.fn(),
        onData: vi.fn(),
        onExit: (callback) => {
          onExit = callback
        },
        dispose: vi.fn()
      }
      return handle
    })
    const gate = new TerminalSpawnGate({
      log: vi.fn(),
      mode: 'enforce',
      pressure: () => pressure,
      hostTerminals: new HostTerminalLedger({ dir: null, maxTerminals, log: vi.fn() }),
      legacyRestores: records
    })
    host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-legacy-restore-gate-'))
    records = new LegacyRestoreRecords(join(dir, 'records.json'), { log: vi.fn() })
    pressure = 'ok'
    nextPid = 3000
    build()
  })

  afterEach(async () => {
    await host.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  function restore(sessionId: string, declaredIntent: SpawnIntent | null = null) {
    return host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      cwd: dir,
      env: { ORCA_AGENT_HOOK_TOKEN: 'secret' },
      command: `claude --resume ${sessionId}`,
      launchAgent: 'claude',
      historySeedChunks: ['seed'],
      agentSessionEnsure: {
        claim: {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: sessionId.padEnd(43, 'a'),
          worktreeScopeDigest: 'b'.repeat(43),
          agent: 'claude' as const
        },
        surface: {
          worktreeId: 'wt-1',
          tabId: `tab-${sessionId}`,
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: `term_${sessionId}`
        }
      },
      spawnAdmission: { clientId: 'old-client', declaredIntent, deadlineAt: Date.now() - 1 },
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  it('records an old client restore refused under pressure, without its environment', async () => {
    pressure = 'critical'
    await expect(restore('agent-a')).rejects.toThrow('terminal_spawn_refused')
    expect(records.list()).toEqual([
      {
        sessionId: 'agent-a',
        reason: 'pressure',
        refusedAt: expect.any(Number),
        agent: 'claude',
        cwd: dir,
        worktreeId: 'wt-1',
        command: 'claude --resume agent-a',
        identityDigest: 'agent-a'.padEnd(43, 'a')
      }
    ])
    expect(JSON.stringify(records.list())).not.toContain('secret')
  })

  it('records an old client restore refused at the host terminal cap', async () => {
    build(1)
    await host.createOrAttach({
      sessionId: 'shell',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    await expect(restore('agent-b')).rejects.toThrow('as many terminals as Orca allows')
    expect(records.list()).toMatchObject([{ sessionId: 'agent-b', reason: 'host_cap' }])
  })

  it('never records a plain shell or a declared restore, which keeps its own handle', async () => {
    build(1)
    await host.createOrAttach({
      sessionId: 'shell',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    await expect(
      host.createOrAttach({
        sessionId: 'shell-2',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow('as many terminals as Orca allows')
    await expect(restore('agent-c', 'automatic-restore')).rejects.toThrow('live_cap')
    expect(records.list()).toEqual([])
  })

  it('drops the record once that agent session starts again from any client', async () => {
    pressure = 'critical'
    await expect(restore('agent-d')).rejects.toThrow('terminal_spawn_refused')
    expect(records.list()).toHaveLength(1)

    pressure = 'ok'
    await expect(restore('agent-d', 'user-resume')).resolves.toMatchObject({ isNew: true })
    expect(records.list()).toEqual([])
  })
})
