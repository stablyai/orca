import { vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import type { DaemonClient } from '../../../transport/client/daemon-client'
import type { DaemonPtyAdapterOptions } from '../daemon-pty-adapter-options'
import { DaemonServer } from '../../../server/daemon-server'
import { getDaemonSocketPath } from '../../../launch/daemon-spawner'
import type { SubprocessHandle } from '../../../sessions/session-subprocess-handle'
import type { DaemonFileLog } from '../../../observability/daemon-file-log'
import type { TerminalExitCause } from '../../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import {
  HOST_HISTORY_OWNER_PROTOCOL_VERSION,
  PROTOCOL_VERSION
} from '../../../protocol/daemon-protocol-version'

/** Fixtures for the main-pulled pipeline that daemons before v57 still use. */
export const LEGACY_HISTORY_PROTOCOL_VERSION = HOST_HISTORY_OWNER_PROTOCOL_VERSION - 1

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
  confirmShellForeground: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  _simulateData: (data: string) => void
  _simulateExit: (code: number, cause?: TerminalExitCause) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number, cause?: TerminalExitCause) => void) | null = null
  return {
    // getCwd falls back to OS lookup; keep the fake PID outside the real process range.
    pid: 999_999_999,
    getForegroundProcess: vi.fn(() => null),
    confirmShellForeground: vi.fn(async () => false),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => {
      setTimeout(() => onExitCb?.(137), 5)
    }),
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
    _simulateExit(code: number, cause?: TerminalExitCause) {
      onExitCb?.(code, cause)
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
  spawnSubprocess: SpawnSubprocess,
  adapterOptions: Pick<
    DaemonPtyAdapterOptions,
    'readRunningWslDistros' | 'historyPath' | 'wslBridgeBootIdentity' | 'protocolVersion'
  > = {},
  serverOptions: { onPtySessionExit?: (sessionId: string) => void; hostHistory?: boolean } = {}
): Promise<DaemonAdapterHarness> {
  const dir = createTestDir()
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  const daemonLogEvents: string[] = []
  // Production v57+ daemons always own history; older protocol fixtures leave it to the adapter.
  const {
    hostHistory = (adapterOptions.protocolVersion ?? PROTOCOL_VERSION) >=
      HOST_HISTORY_OWNER_PROTOCOL_VERSION,
    ...daemonOptions
  } = serverOptions
  const daemonLog: DaemonFileLog = {
    log: (event) => daemonLogEvents.push(event),
    close() {}
  }
  const server = new DaemonServer({
    socketPath,
    tokenPath,
    log: daemonLog,
    spawnSubprocess,
    // A daemon and the adapter that reaches it speak the same protocol generation.
    ...(adapterOptions.protocolVersion !== undefined
      ? { protocolVersion: adapterOptions.protocolVersion }
      : {}),
    ...(hostHistory ? { historyRoot: join(dir, 'history') } : {}),
    ...daemonOptions
  })
  await server.start()
  const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, ...adapterOptions })
  return { dir, socketPath, tokenPath, server, adapter, daemonLog, daemonLogEvents }
}

/** An adapter whose next reply of one request type a test can hold until it chooses. */
export class ReplyHoldingAdapter extends DaemonPtyAdapter {
  /** Resolves once that reply has arrived; the caller then sees it only after `release`. */
  holdNextReply(type: string, release: Promise<void>): Promise<void> {
    const client: DaemonClient = this.client
    const send = client.request.bind(client)
    const arrived = Promise.withResolvers<void>()
    const spy = vi.spyOn(client, 'request').mockImplementation(async function <T>(
      ...args: Parameters<typeof send>
    ): Promise<T> {
      const result = await send<T>(...args)
      if (args[0] === type) {
        spy.mockRestore()
        arrived.resolve()
        await release
      }
      return result
    })
    return arrived.promise
  }
}
