import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { terminateProviderFaultDescendants } from './provider-fault-ownership'
import type { ProviderProcessRow, ProcessRowRead } from './provider-process-row-read'
import type { ProcessTableRow } from '../pty/process-retirement/pty-process-table-parser'

const NOW = Date.parse('2026-11-15T12:00:00.100Z')
const leader: ProviderProcessRow = {
  pid: 100,
  ppid: 90,
  pgid: 100,
  startedAt: '2026-11-15T11:00:00.000Z',
  startResolution: 'second'
}
const watcher = { ...leader, pid: 101, ppid: 100, pgid: 101 }
const identity = { leader, watcher, pgid: 100 }
const root: ProcessTableRow = { ...leader, startedAt: new Date(leader.startedAt).toString() }
const tool = { ...root, pid: 200, ppid: 100, pgid: 200 }
const sameGroupChild = { ...tool, pid: 300, pgid: 100 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

it('terminates captured same-group and detached tools even after both anchors disappear', async () => {
  let rootReads = 0
  const live = new Map([tool, sameGroupChild].map((row) => [row.pid, row]))
  const sendSignal = vi.fn((pid: number, signal: NodeJS.Signals) => {
    if (signal === 'SIGKILL') {
      live.delete(pid)
    }
  })
  const pending = terminateProviderFaultDescendants(identity, {
    readProcessRow: async () => (++rootReads <= 2 ? leader : null),
    readTable: async () => {
      const rows = rootReads === 1 ? [root, watcher, ...live.values()] : [...live.values()]
      return { rows, capturedAtMs: Date.now() }
    },
    sendSignal
  })
  await vi.runAllTimersAsync()
  await expect(pending).resolves.toBe('exited')
  expect(sendSignal.mock.calls).toEqual([
    [200, 'SIGTERM'],
    [300, 'SIGTERM'],
    [200, 'SIGKILL'],
    [300, 'SIGKILL']
  ])
})

it.each([
  'wrong-start',
  'same-second',
  'reused-during-capture',
  'wrong-table-root',
  'duplicate-root'
])('refuses descendant signals for a %s root', async (fault) => {
  const expected =
    fault === 'same-second' ? { ...leader, startedAt: '2026-11-15T12:00:00.000Z' } : leader
  let reads = 0
  const actual = { ...expected, startedAt: '2026-11-15T11:30:00.000Z' }
  const sendSignal = vi.fn()
  const pending = terminateProviderFaultDescendants(
    { ...identity, leader: expected },
    {
      readProcessRow: async (): Promise<ProcessRowRead> => {
        reads += 1
        return fault === 'wrong-start' || (fault === 'reused-during-capture' && reads > 1)
          ? actual
          : expected
      },
      readTable: async () => ({
        rows: [
          fault === 'wrong-table-root'
            ? { ...root, startedAt: new Date(actual.startedAt).toString() }
            : { ...root, startedAt: new Date(expected.startedAt).toString() },
          ...(fault === 'duplicate-root' ? [root] : []),
          tool
        ],
        capturedAtMs: Date.now()
      }),
      sendSignal
    }
  )
  await vi.runAllTimersAsync()
  await expect(pending).resolves.toBe('unverifiable')
  expect(sendSignal).not.toHaveBeenCalled()
})

it('never uses a recycled root to authorize escalation of birth-second descendants', async () => {
  let reads = 0
  const bornNow = { ...tool, startedAt: new Date(NOW).toString() }
  const sendSignal = vi.fn()
  const pending = terminateProviderFaultDescendants(identity, {
    readProcessRow: async () => {
      reads += 1
      return reads <= 2 ? leader : { ...leader, startedAt: '2026-11-15T11:30:00.000Z' }
    },
    readTable: async () => ({ rows: [root, bornNow], capturedAtMs: Date.now() }),
    sendSignal
  })
  await vi.runAllTimersAsync()
  await expect(pending).resolves.toBe('live')
  expect(sendSignal).not.toHaveBeenCalled()
})

it('allows both bounded identity reads around a slow process-table capture', async () => {
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 900))
  let live = true
  const sendSignal = vi.fn((_pid: number, signal: NodeJS.Signals) => {
    if (signal === 'SIGKILL') {
      live = false
    }
  })
  const pending = terminateProviderFaultDescendants(identity, {
    readProcessRow: async () => {
      await wait()
      return leader
    },
    readTable: async () => {
      await wait()
      return { rows: [root, ...(live ? [tool] : [])], capturedAtMs: Date.now() }
    },
    sendSignal
  })
  await vi.runAllTimersAsync()
  await expect(pending).resolves.toBe('exited')
  expect(sendSignal.mock.calls).toEqual([
    [200, 'SIGTERM'],
    [200, 'SIGKILL']
  ])
})

it('retries an unreadable root without treating it as a recycled identity', async () => {
  let reads = 0
  let live = true
  const bornNow = { ...tool, startedAt: new Date(NOW).toString() }
  const sendSignal = vi.fn((_pid: number, signal: NodeJS.Signals) => {
    if (signal === 'SIGKILL') {
      live = false
    }
  })
  const pending = terminateProviderFaultDescendants(identity, {
    readProcessRow: async () => (++reads === 3 ? 'unverifiable' : leader),
    readTable: async () => ({ rows: [root, ...(live ? [bornNow] : [])], capturedAtMs: Date.now() }),
    sendSignal
  })
  await vi.runAllTimersAsync()
  await expect(pending).resolves.toBe('exited')
  expect(sendSignal.mock.calls).toEqual([
    [200, 'SIGTERM'],
    [200, 'SIGKILL']
  ])
})
