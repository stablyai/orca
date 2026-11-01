import { describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry, PluginHostStatus } from '../../shared/plugins/plugin-list-entry'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'
import { formatPluginDevWatchEvent, type PluginDevWatchEvent } from './plugin-dev-watch-events'
import { runPluginDevWatch, type PluginDevWatchHost } from './plugin-dev-watch-loop'
import {
  isLastingShotFailure,
  shootPluginPanels,
  type PluginDevWatchShot
} from './plugin-dev-watch-shot'

const KEY = 'acme.todos'

function entry(devChangeCount: number, status: PluginHostStatus = 'idle'): PluginHostListEntry {
  return {
    pluginKey: KEY,
    consentFingerprint: 'sha256-x',
    name: 'Todos',
    version: '1.0.0',
    publisher: 'acme',
    status,
    needsReconsent: false,
    isDev: true,
    devChangeCount,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0
  }
}

const SHOT: PluginDevWatchShot = {
  panelId: 'todos',
  path: '/work/shots/acme.todos-todos.png',
  width: 360,
  height: 700,
  settled: true,
  errors: []
}

/** Polls: baseline, status (unchanged), logs, status (`afterSave`), logs, Ctrl-C. */
async function watch(
  host: Pick<PluginDevWatchHost, 'check' | 'shot'>,
  afterSave: PluginHostListEntry = entry(1)
): Promise<PluginDevWatchEvent[]> {
  const events: PluginDevWatchEvent[] = []
  const lists = [[entry(0)], [afterSave]]
  let interrupt = () => {}
  let poll = 0
  await runPluginDevWatch({
    host: {
      refreshTypes: async () => [],
      devLoad: async () => ({
        path: '/work/todos',
        pluginKey: KEY,
        added: true,
        approval: 'approve-flag',
        plugin: entry(0)
      }),
      list: async () => lists.shift() ?? [afterSave],
      logs: async () => ({ pluginKey: KEY, lines: [] }),
      approvalNeeded: async () => null,
      devUnload: async () => {},
      ...host
    },
    emit: (event) => events.push(event),
    wait: async () => {
      poll += 1
      if (poll === 6) {
        interrupt()
      }
    },
    onInterrupt: (listener) => {
      interrupt = listener
      return () => {}
    },
    exitNow: () => {},
    isConnectionLost: () => false
  })
  return events
}

describe('plugin dev watch --shot', () => {
  it('shoots after the load and after each reload, after the check', async () => {
    const order: string[] = []
    const events = await watch({
      check: async () => {
        order.push('check')
        return { ok: true, invalid: [], panels: [] }
      },
      shot: async (pluginKey) => {
        order.push(`shot ${pluginKey}`)
        return [SHOT]
      }
    })
    expect(order).toEqual(['check', `shot ${KEY}`, 'check', `shot ${KEY}`])
    const shots = events.filter((event) => event.type === 'shot')
    expect(shots).toHaveLength(2)
    expect(events.indexOf(shots[1]!)).toBeGreaterThan(
      events.findIndex((event) => event.type === 'reloaded')
    )
    expect(events.at(-1)?.type).toBe('unloaded')
    expect(formatPluginDevWatchEvent(shots[0]!)).toBe(
      'shot /work/shots/acme.todos-todos.png (360x700)'
    )
  })

  it('skips a reload that left the plugin errored', async () => {
    const shot = vi.fn(async () => [SHOT])
    await watch({ shot }, entry(1, 'errored'))
    expect(shot).toHaveBeenCalledTimes(1)
  })

  it('turns itself off when the host can never capture', async () => {
    const shot = vi.fn(async (): Promise<PluginDevWatchShot[]> => {
      throw new RuntimeClientError('runtime_unsupported', 'too old')
    })
    const events = await watch({ shot })
    expect(shot).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({
      type: 'warning',
      message: 'shot could not run, so --shot is off: too old'
    })
  })

  it('keeps shooting after a one-off failure', async () => {
    const shot = vi
      .fn<NonNullable<PluginDevWatchHost['shot']>>()
      .mockRejectedValueOnce(new Error('no workspace'))
      .mockResolvedValueOnce([{ ...SHOT, settled: false, errors: ['boom'] }])
    const events = await watch({ shot })
    expect(shot).toHaveBeenCalledTimes(2)
    const last = events.findLast((event) => event.type === 'shot')
    expect(last && formatPluginDevWatchEvent(last)).toBe(
      'shot /work/shots/acme.todos-todos.png (360x700), not finished drawing\n  error: boom'
    )
  })
})

describe('isLastingShotFailure', () => {
  it('is true for an old host or a windowless one, not for passing trouble', () => {
    const reply = (message: string) =>
      new RuntimeRpcFailureError({
        id: 'r',
        ok: false,
        error: { code: 'runtime_error', message },
        _meta: { runtimeId: 'runtime_local' }
      })
    expect(isLastingShotFailure(new RuntimeClientError('runtime_unsupported', 'old'))).toBe(true)
    expect(
      isLastingShotFailure(reply('Showing plugin panels is only available in the Orca desktop app'))
    ).toBe(true)
    expect(isLastingShotFailure(reply('no workspace'))).toBe(false)
    expect(isLastingShotFailure(new Error('timeout'))).toBe(false)
  })
})

describe('shootPluginPanels', () => {
  it('captures one panel at a time, in order', async () => {
    let running = 0
    const shots = await shootPluginPanels(['a', 'b'], async (panelId) => {
      running += 1
      expect(running).toBe(1)
      await Promise.resolve()
      running -= 1
      return { ...SHOT, panelId }
    })
    expect(shots.map((shot) => shot.panelId)).toEqual(['a', 'b'])
  })
})
