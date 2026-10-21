import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import { TerminalHost } from './terminal-host'

import './mock-descendant-sweep'

function subprocess() {
  let dataListener: ((data: string) => void) | undefined
  let exitListener: ((code: number) => void) | undefined
  return {
    pid: 424242,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    signal() {},
    kill() {
      exitListener?.(0)
    },
    forceKill() {
      exitListener?.(137)
    },
    terminateOwnedTree: () => 'unavailable' as const,
    onData(listener: (data: string) => void) {
      dataListener = listener
    },
    onExit(listener: (code: number) => void) {
      exitListener = listener
    },
    dispose() {
      dataListener = undefined
      exitListener = undefined
    },
    emitData(data: string) {
      dataListener?.(data)
    },
    emitExit(code: number) {
      exitListener?.(code)
    }
  } satisfies SubprocessHandle & {
    emitData: (data: string) => void
    emitExit: (code: number) => void
  }
}

const streamClient = { onData() {}, onExit() {} }

function startWithInputs(host: TerminalHost, sessionId: string) {
  const controller = new AbortController()
  const env = { RETENTION_FIXTURE: 'x'.repeat(1024) }
  const historySeedChunks = ['retention-seed\r\n']
  const options: InternalCreateOrAttachOptions = {
    sessionId,
    cols: 80,
    rows: 24,
    env,
    historySeedChunks,
    streamClient,
    cancelSignal: controller.signal,
    isCanceled: () => controller.signal.aborted
  }
  return {
    refs: [
      new WeakRef(options),
      new WeakRef(env),
      new WeakRef(historySeedChunks),
      new WeakRef(controller.signal)
    ],
    creation: host.createOrAttach(options)
  }
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 4; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

describe('TerminalHost completed spawn inputs', () => {
  it('releases request, environment, consumed history and cancellation inputs for live sessions', async () => {
    const host = new TerminalHost({ spawnSubprocess: async () => subprocess() })
    try {
      const refs: WeakRef<object>[] = []
      for (let index = 0; index < 3; index += 1) {
        const created = startWithInputs(host, `retention-${index}`)
        expect((await created.creation).historySeeded).toBe(true)
        refs.push(...created.refs)
      }
      await collect()
      expect(refs.map((ref) => ref.deref() === undefined)).toEqual(Array(12).fill(true))
      expect(host.listSessions()).toHaveLength(3)
      expect(host.getSnapshot('retention-0')?.snapshotAnsi).toContain('retention-seed')
    } finally {
      await host.dispose()
    }
  })

  it('retains inputs during spawn and releases them after publication', async () => {
    const gate = Promise.withResolvers<void>()
    const host = new TerminalHost({
      spawnSubprocess: async () => {
        await gate.promise
        return subprocess()
      }
    })
    const created = startWithInputs(host, 'pending')
    try {
      await collect()
      expect(created.refs.map((ref) => ref.deref() !== undefined)).toEqual(Array(4).fill(true))
      gate.resolve()
      expect((await created.creation).isNew).toBe(true)
      await collect()
      expect(created.refs.map((ref) => ref.deref() === undefined)).toEqual(Array(4).fill(true))
      expect(host.listSessions()).toHaveLength(1)
    } finally {
      gate.resolve()
      await created.creation
      await host.dispose()
    }
  })

  it('reaps exited sessions, preserves exit evidence and releases claimed generations', async () => {
    const handles: ReturnType<typeof subprocess>[] = []
    const reaped: string[] = []
    const host = new TerminalHost({
      spawnSubprocess: async () => {
        const handle = subprocess()
        handles.push(handle)
        return handle
      },
      onSessionReaped: (sessionId) => reaped.push(sessionId)
    })
    const options = {
      sessionId: 'claimed',
      cols: 80,
      rows: 24,
      streamClient,
      agentSessionEnsure: {
        claim: {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: 'a'.repeat(43),
          worktreeScopeDigest: 'b'.repeat(43),
          agent: 'codex' as const
        },
        surface: {
          worktreeId: 'worktree',
          tabId: 'tab',
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: 'term_claimed'
        }
      }
    }
    try {
      const first = await host.createOrAttach(options)
      handles[0]?.emitExit(7)
      expect(reaped).toEqual(['claimed'])
      expect(host.listSessions()).toEqual([])
      expect(
        await host.inspectProcess('claimed', { expectedIncarnationId: first.incarnationId })
      ).toMatchObject({
        foregroundProcessEvidence: {
          verdict: 'exited',
          reason: 'pty_exit_7',
          ptyIncarnationId: first.incarnationId
        }
      })
      const second = await host.createOrAttach(options)
      expect(second.agentSessionEnsure?.disposition).toBe('created')
      expect(second.incarnationId).not.toBe(first.incarnationId)
      expect(second.agentSessionEnsure?.owner.generation).not.toBe(
        first.agentSessionEnsure?.owner.generation
      )
      expect(handles).toHaveLength(2)
    } finally {
      await host.dispose()
    }
    expect(reaped).toEqual(['claimed', 'claimed'])
  })

  it('confirms shell recovery with the subprocess receiver and releases queued output', async () => {
    let confirmations = 0
    const gate = Promise.withResolvers<boolean>()
    const handle = {
      ...subprocess(),
      confirmShellForeground() {
        expect(this).toBe(handle)
        confirmations += 1
        return gate.promise
      }
    }
    const host = new TerminalHost({ spawnSubprocess: async () => handle })
    try {
      await host.createOrAttach({ sessionId: 'recovery', cols: 80, rows: 24, streamClient })
      handle.emitData('\x1b[?1049hTUI\x1b]133;D;137\x07SHELL-PROMPT')
      await vi.waitFor(() => expect(confirmations).toBe(1))
      gate.resolve(true)
      const snapshot = await host.getSettledSnapshot('recovery')
      expect(snapshot?.terminalOwner).toBe('shell')
      expect(snapshot?.snapshotAnsi).toContain('SHELL-PROMPT')
    } finally {
      gate.resolve(false)
      await host.dispose()
    }
  })
})
