import { afterEach, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { localOmpRpcSessionWriteFence } from '../omp-rpc/omp-rpc-local-session-write-fence'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

function createAdapter(incarnationId?: string): {
  adapter: DaemonPtyAdapter
  emitExit: (id: string, exitIncarnationId?: string) => void
} {
  let onExit: ((payload: { id: string; code: number; incarnationId?: string }) => void) | undefined
  const noOpSubscription = () => () => {}
  return {
    adapter: {
      spawn: vi.fn(async () => ({ id: 'pty-1', incarnationId })),
      shutdown: vi.fn(async () => {}),
      onData: noOpSubscription,
      onExit: (listener) => {
        onExit = listener
        return () => {}
      },
      onBackgroundStreamEvent: noOpSubscription,
      onWriteUnavailable: noOpSubscription
    } as unknown as DaemonPtyAdapter,
    emitExit: (id, exitIncarnationId) => onExit?.({ id, code: 0, incarnationId: exitIncarnationId })
  }
}

afterEach(() => {
  localOmpRpcSessionWriteFence.release('/sessions/current.jsonl', 'rpc-pane:1')
})

it('holds a daemon OMP resume fence until the spawned PTY exits', async () => {
  const current = createAdapter()
  const router = new DaemonPtyRouter({ current: current.adapter, legacy: [] })
  const sessionFilePath = '/sessions/current.jsonl'

  await router.spawn({
    cols: 80,
    rows: 24,
    cwd: '/work',
    command: `omp --resume ${sessionFilePath}`
  })

  expect(localOmpRpcSessionWriteFence.reserve(sessionFilePath, 'rpc-pane:1')).toBe(false)
  current.emitExit('pty-1')
  expect(localOmpRpcSessionWriteFence.reserve(sessionFilePath, 'rpc-pane:1')).toBe(true)
})

it('does not release a reused daemon PTY fence for an older incarnation exit', async () => {
  const current = createAdapter('current-incarnation')
  const router = new DaemonPtyRouter({ current: current.adapter, legacy: [] })
  const sessionFilePath = '/sessions/current.jsonl'

  await router.spawn({
    cols: 80,
    rows: 24,
    cwd: '/work',
    command: `omp --resume ${sessionFilePath}`
  })
  current.emitExit('pty-1', 'older-incarnation')
  expect(localOmpRpcSessionWriteFence.reserve(sessionFilePath, 'rpc-pane:1')).toBe(false)

  current.emitExit('pty-1', 'current-incarnation')
  expect(localOmpRpcSessionWriteFence.reserve(sessionFilePath, 'rpc-pane:1')).toBe(true)
})

it('keeps a daemon OMP resume fence after graceful shutdown acknowledgement until exit', async () => {
  const current = createAdapter()
  const router = new DaemonPtyRouter({ current: current.adapter, legacy: [] })
  const sessionFilePath = '/sessions/current.jsonl'
  await router.spawn({ cols: 80, rows: 24, cwd: '/work', command: `omp --resume ${sessionFilePath}` })

  await router.shutdown('pty-1', { immediate: false })
  expect(localOmpRpcSessionWriteFence.reserve(sessionFilePath, 'rpc-pane:1')).toBe(false)

  current.emitExit('pty-1')
  expect(localOmpRpcSessionWriteFence.reserve(sessionFilePath, 'rpc-pane:1')).toBe(true)
})
