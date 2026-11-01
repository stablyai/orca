import { describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import type { LogsResult } from '../handlers/plugin-runtime'
import type { PluginDevWatchEvent } from './plugin-dev-watch-events'
import { formatPluginDevWatchEvent } from './plugin-dev-watch-events'
import { runPluginDevWatch, type PluginDevWatchHost } from './plugin-dev-watch-loop'

const KEY = 'acme.notes'
const PATH = '/work/notes'

function entry(overrides: Partial<PluginHostListEntry> = {}): PluginHostListEntry {
  return {
    pluginKey: KEY,
    consentFingerprint: 'sha256-x',
    name: 'Notes',
    version: '1.0.0',
    publisher: 'acme',
    status: 'running',
    needsReconsent: false,
    isDev: true,
    devChangeCount: 0,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: true,
    restarts: 0,
    ...overrides
  }
}

class LostError extends Error {}

/** A scripted host: each poll (one wait) advances to the next step. */
function harness(options: {
  added?: boolean
  logs?: LogsResult[]
  lists?: PluginHostListEntry[][]
  failAt?: { poll: number; error: Error }
  stopAfterPolls?: number
  approvalNeeded?: PluginDevWatchHost['approvalNeeded']
  devUnload?: PluginDevWatchHost['devUnload']
}) {
  const events: PluginDevWatchEvent[] = []
  let interrupt: () => void = () => {}
  let poll = 0
  const logs = options.logs ?? []
  const lists = options.lists ?? []
  const logCalls: (string | undefined)[] = []
  const host: PluginDevWatchHost = {
    refreshTypes: vi.fn(async () => ['.orca/types/orca/index.d.ts']),
    devLoad: vi.fn(async () => ({
      path: PATH,
      pluginKey: KEY,
      added: options.added ?? true,
      approval: 'approve-flag' as const,
      plugin: entry()
    })),
    list: vi.fn(async () => {
      if (options.failAt?.poll === poll) {
        throw options.failAt.error
      }
      return lists.shift() ?? [entry()]
    }),
    logs: vi.fn(async (_key: string, after: string | undefined) => {
      logCalls.push(after)
      if (options.failAt?.poll === poll) {
        throw options.failAt.error
      }
      return logs.shift() ?? { pluginKey: KEY, lines: [] }
    }),
    approvalNeeded: options.approvalNeeded ?? vi.fn(async () => null),
    devUnload: options.devUnload ?? vi.fn(async () => {})
  }
  const unsubscribe = vi.fn()
  const exitNow = vi.fn()
  const run = runPluginDevWatch({
    host,
    emit: (event) => events.push(event),
    wait: async () => {
      poll += 1
      if (poll === (options.stopAfterPolls ?? 4)) {
        interrupt()
      }
    },
    onInterrupt: (listener) => {
      interrupt = listener
      return unsubscribe
    },
    exitNow,
    isConnectionLost: (error) => error instanceof LostError
  })
  return { run, events, host, logCalls, unsubscribe, exitNow, interrupt: () => interrupt() }
}

const line = (ts: number, text: string, level = 'info') => ({ ts, level, line: text })

describe('runPluginDevWatch', () => {
  it('loads, skips old lines, follows the host cursor, and unloads on Ctrl-C', async () => {
    const { run, events, host, logCalls, unsubscribe } = harness({
      logs: [
        { pluginKey: KEY, lines: [line(1, 'before the session')], cursor: 'n:1' },
        { pluginKey: KEY, lines: [line(2, '[frame] panel.tsx:3 boom', 'error')], cursor: 'n:2' },
        { pluginKey: KEY, lines: [], cursor: 'n:2' }
      ]
    })
    await expect(run).resolves.toBe(0)
    expect(logCalls.slice(0, 3)).toEqual([undefined, 'n:1', 'n:2'])
    expect(events.map((event) => event.type)).toEqual(['loaded', 'log', 'unloaded'])
    expect(events[1]).toMatchObject({ line: '[frame] panel.tsx:3 boom', level: 'error' })
    expect(events.at(-1)).toEqual({ type: 'unloaded', pluginKey: KEY, path: PATH, removed: true })
    expect(host.devUnload).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('de-duplicates whole-ring replies from hosts without the cursor', async () => {
    const { run, events } = harness({
      logs: [
        { pluginKey: KEY, lines: [line(5, 'a')] },
        { pluginKey: KEY, lines: [line(5, 'a'), line(5, 'b')] },
        { pluginKey: KEY, lines: [line(5, 'a'), line(5, 'b'), line(6, 'c')] }
      ]
    })
    await run
    expect(events.filter((event) => event.type === 'log').map((event) => event.line)).toEqual([
      'b',
      'c'
    ])
  })

  it('reports a reload with the new status, and a later status change', async () => {
    const { run, events } = harness({
      stopAfterPolls: 6,
      lists: [
        [entry({ devChangeCount: 2, status: 'errored', error: 'SyntaxError in main.ts:4' })],
        [entry({ devChangeCount: 2, status: 'running' })]
      ]
    })
    await run
    const reload = events.find((event) => event.type === 'reloaded')
    expect(reload).toEqual({
      type: 'reloaded',
      pluginKey: KEY,
      changes: 2,
      status: 'errored',
      error: 'SyntaxError in main.ts:4'
    })
    expect(reload && formatPluginDevWatchEvent(reload)).toBe(
      '↻ reloaded acme.notes (2 files changed): errored: SyntaxError in main.ts:4'
    )
    expect(events.find((event) => event.type === 'status')).toMatchObject({
      status: 'running',
      previousStatus: 'errored'
    })
  })

  it('prints a reload before the lines its new code logged in the same poll', async () => {
    const { run, events } = harness({
      logs: [
        { pluginKey: KEY, lines: [], cursor: 'n:0' },
        { pluginKey: KEY, lines: [line(2, 'new code started')], cursor: 'n:1' }
      ],
      lists: [[entry({ devChangeCount: 1 })]]
    })
    await run
    expect(events.map((event) => event.type)).toEqual(['loaded', 'reloaded', 'log', 'unloaded'])
  })

  it('follows a manifest that stopped parsing to the one new invalid dev entry', async () => {
    const stray = entry({
      pluginKey: 'invalid-development-plugin-2',
      status: 'invalid',
      error: 'invalid manifest: id',
      devChangeCount: 1
    })
    const { run, events } = harness({
      lists: [[entry(), entry({ pluginKey: 'acme.other', isDev: false })], [stray]]
    })
    await run
    expect(events.find((event) => event.type === 'reloaded')).toMatchObject({
      status: 'invalid',
      error: 'invalid manifest: id'
    })
  })

  it('prints the approval command once when an edit asks for new access', async () => {
    const approvalNeeded = vi.fn(async () => ({
      message: 'acme.notes asks for new access',
      fingerprint: 'ap1-x',
      command: 'orca plugin dev reload /work/notes --approve ap1-x'
    }))
    const { run, events } = harness({
      stopAfterPolls: 6,
      approvalNeeded,
      lists: [
        [entry({ devChangeCount: 1, status: 'pending', needsReconsent: true })],
        [entry({ devChangeCount: 1, status: 'pending', needsReconsent: true })]
      ]
    })
    await run
    expect(approvalNeeded).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === 'approval')).toEqual([
      expect.objectContaining({ fingerprint: 'ap1-x', command: expect.stringContaining('reload') })
    ])
  })

  it('exits 1 without unloading when the host connection drops', async () => {
    const { run, events, host } = harness({
      failAt: { poll: 1, error: new LostError('connect ECONNREFUSED') }
    })
    await expect(run).resolves.toBe(1)
    expect(events.at(-1)).toEqual({ type: 'disconnected', message: 'connect ECONNREFUSED' })
    expect(host.devUnload).not.toHaveBeenCalled()
  })

  it('reports a host-side poll failure once and keeps watching', async () => {
    const { run, events } = harness({
      stopAfterPolls: 6,
      failAt: { poll: 2, error: new Error('Plugin service is not available') }
    })
    await expect(run).resolves.toBe(0)
    expect(events.filter((event) => event.type === 'warning')).toHaveLength(1)
  })

  it('leaves a folder loaded before the session in place', async () => {
    const { run, events, host } = harness({ added: false })
    await expect(run).resolves.toBe(0)
    expect(host.devUnload).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ type: 'unloaded', removed: false })
  })

  it('exits at once on a second Ctrl-C while unloading', async () => {
    let secondInterrupt: () => void = () => {}
    const devUnload = vi.fn(async () => secondInterrupt())
    const h = harness({ devUnload })
    secondInterrupt = h.interrupt
    await h.run
    expect(devUnload).toHaveBeenCalledTimes(1)
    expect(h.exitNow).toHaveBeenCalledWith(130)
  })

  it('propagates a first-load approval error so the CLI exits 3', async () => {
    const h = harness({})
    vi.mocked(h.host.devLoad).mockRejectedValueOnce(
      Object.assign(new Error('approval needed'), { code: 'approval_required' })
    )
    await expect(h.run).rejects.toMatchObject({ code: 'approval_required' })
    expect(h.events).toEqual([])
  })
})
