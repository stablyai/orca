/* Shared daemon server + adapter fixtures for the DaemonPtyAdapter test files. */
import { vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { DaemonFileLog } from './daemon-file-log'

export type SpawnSubprocess = ConstructorParameters<typeof DaemonServer>[0]['spawnSubprocess']

export type DaemonAdapterHarness = {
  dir: string
  socketPath: string
  tokenPath: string
  server: DaemonServer
  adapter: DaemonPtyAdapter
  daemonLog: DaemonFileLog
  daemonLogEvents: string[]
}

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-adapter-test-'))
}

export function createMockSubprocess(dataOnSubscribe?: string): SubprocessHandle & {
  write: ReturnType<typeof vi.fn<(data: string) => void>>
  pause: ReturnType<typeof vi.fn<() => void>>
  resume: ReturnType<typeof vi.fn<() => void>>
  _simulateData: (data: string) => void
  _simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    // Why: getCwd falls back to OS pid lookup; an implausibly-high fake pid can't collide with a real process' cwd.
    pid: 999_999_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => setTimeout(() => onExitCb?.(137), 5)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
      if (dataOnSubscribe) {
        cb(dataOnSubscribe)
      }
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    _simulateData(data: string) {
      onDataCb?.(data)
    },
    _simulateExit(code: number) {
      onExitCb?.(code)
    }
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Boots a real daemon server over a temp socket plus a lazily-connecting adapter. */
export async function startDaemonAdapterHarness(
  spawnSubprocess: SpawnSubprocess
): Promise<DaemonAdapterHarness> {
  const dir = createTestDir()
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  const daemonLogEvents: string[] = []
  const daemonLog: DaemonFileLog = {
    log: (event) => daemonLogEvents.push(event),
    close() {}
  }
  const server = new DaemonServer({ socketPath, tokenPath, log: daemonLog, spawnSubprocess })
  await server.start()
  const adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
  return { dir, socketPath, tokenPath, server, adapter, daemonLog, daemonLogEvents }
}
