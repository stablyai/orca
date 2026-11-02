import { describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry, PluginHostStatus } from '../../shared/plugins/plugin-list-entry'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'
import { formatPluginDevWatchEvent, type PluginDevWatchEvent } from './plugin-dev-watch-events'
import { runPluginDevWatch, type PluginDevWatchHost } from './plugin-dev-watch-loop'
import {
  isLastingShotFailure,
  pluginDevWatchShotPanel,
  type PluginDevWatchShot,
  type PluginDevWatchShotHost
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
    panels: [
      { id: 'todos', title: 'Todos', tabKey: `plugin:${KEY}/todos` },
      { id: 'stats', title: 'Stats', tabKey: `plugin:${KEY}/stats` }
    ],
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

type Take = PluginDevWatchShotHost['take']

function shotHost(take: Take, requested?: string) {
  const open = vi.fn<PluginDevWatchShotHost['open']>(async () => {})
  const host: PluginDevWatchShotHost = {
    panelOf: (loaded) => pluginDevWatchShotPanel(loaded, requested),
    open,
    take: vi.fn(take)
  }
  return { host, open, take: host.take }
}

/** The load, then one status poll per entry in `saves` (each one save later), then Ctrl-C. */
async function watch(
  host: Partial<Pick<PluginDevWatchHost, 'check' | 'shot' | 'devUnload'>>,
  saves: PluginHostListEntry[] = [entry(1)]
): Promise<PluginDevWatchEvent[]> {
  const events: PluginDevWatchEvent[] = []
  const lists = [[entry(0)], ...saves.map((save) => [save])]
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
      list: async () => lists.shift() ?? [saves.at(-1) ?? entry(0)],
      logs: async () => ({ pluginKey: KEY, lines: [] }),
      approvalNeeded: async () => null,
      devUnload: async () => {},
      ...host
    },
    emit: (event) => events.push(event),
    wait: async () => {
      poll += 1
      if (poll === 2 * (saves.length + 1)) {
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

const ofType = <T extends PluginDevWatchEvent['type']>(events: PluginDevWatchEvent[], type: T) =>
  events.filter((event): event is Extract<PluginDevWatchEvent, { type: T }> => event.type === type)

describe('plugin dev watch --shot', () => {
  it('opens the panel once, then shoots it after the load and each reload, after the check', async () => {
    const order: string[] = []
    const { host, open } = shotHost(async (pluginKey, panelId) => {
      order.push(`shot ${pluginKey}/${panelId}`)
      return SHOT
    })
    const events = await watch(
      {
        check: async () => {
          order.push('check')
          return { ok: true, invalid: [], panels: [] }
        },
        shot: host
      },
      [entry(1), entry(2)]
    )
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(KEY, 'todos')
    expect(order).toEqual([
      'check',
      `shot ${KEY}/todos`,
      'check',
      `shot ${KEY}/todos`,
      'check',
      `shot ${KEY}/todos`
    ])
    const shots = ofType(events, 'shot')
    expect(shots).toHaveLength(3)
    expect(events.at(-1)?.type).toBe('unloaded')
    expect(formatPluginDevWatchEvent(shots[0]!)).toBe(
      'shot /work/shots/acme.todos-todos.png (360x700)'
    )
  })

  it('shoots --shot-panel and fails at start, unloading, on an unknown id', async () => {
    const { host, open } = shotHost(async () => ({ ...SHOT, panelId: 'stats' }), 'stats')
    await watch({ shot: host })
    expect(open).toHaveBeenCalledWith(KEY, 'stats')

    const devUnload = vi.fn(async () => {})
    await expect(
      watch({ shot: shotHost(async () => SHOT, 'nope').host, devUnload })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--shot-panel: acme.todos has no panel nope; its panels: todos, stats.'
    })
    expect(devUnload).toHaveBeenCalledTimes(1)
  })

  it('skips while away, says so once per time away, and resumes when back', async () => {
    const outcomes: Awaited<ReturnType<Take>>[] = [
      SHOT,
      { notShown: 'the right sidebar shows another tab' },
      { notShown: 'the right sidebar shows another tab' },
      SHOT,
      { notShown: 'the right sidebar is closed' }
    ]
    const { host, open } = shotHost(async () => outcomes.shift() ?? SHOT)
    const events = await watch({ shot: host }, [entry(1), entry(2), entry(3), entry(4)])
    expect(open).toHaveBeenCalledTimes(1)
    expect(
      events
        .filter((event) => event.type === 'shot' || event.type === 'shot_skipped')
        .map((event) => event.type)
    ).toEqual(['shot', 'shot_skipped', 'shot', 'shot_skipped'])
    const skipped = ofType(events, 'shot_skipped')
    expect(skipped[0]).toEqual({
      type: 'shot_skipped',
      pluginKey: KEY,
      panelId: 'todos',
      reason: 'the right sidebar shows another tab'
    })
    expect(formatPluginDevWatchEvent(skipped[1]!)).toBe(
      'shot skipped: the right sidebar is closed, so todos is not on screen; open it again to resume'
    )
  })

  it('skips a reload that left the plugin errored', async () => {
    const { host, take } = shotHost(async () => SHOT)
    await watch({ shot: host }, [entry(1, 'errored')])
    expect(take).toHaveBeenCalledTimes(1)
  })

  it('turns itself off when the host can never capture', async () => {
    const { host, take } = shotHost(async () => {
      throw new RuntimeClientError('runtime_unsupported', 'too old')
    })
    host.open = async () => {
      throw new RuntimeClientError('runtime_unsupported', 'too old')
    }
    const events = await watch({ shot: host }, [entry(1), entry(2)])
    expect(take).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      type: 'warning',
      message: 'could not show todos for --shot, so --shot is off: too old'
    })
  })

  it('keeps going after a one-off failure', async () => {
    const outcomes: (() => Awaited<ReturnType<Take>>)[] = [
      () => {
        throw new Error('timeout')
      },
      () => ({ ...SHOT, settled: false, errors: ['boom'] })
    ]
    const { host, take } = shotHost(async () => (outcomes.shift() ?? (() => SHOT))())
    const events = await watch({ shot: host })
    expect(take).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual({ type: 'warning', message: 'shot could not run: timeout' })
    const last = ofType(events, 'shot').at(-1)
    expect(last && formatPluginDevWatchEvent(last)).toBe(
      'shot /work/shots/acme.todos-todos.png (360x700), not finished drawing\n  error: boom'
    )
  })

  it('carries pendingRequests into the shot event and notes it only when some are unanswered', async () => {
    const outcomes = [
      { ...SHOT, pendingRequests: 2 },
      { ...SHOT, pendingRequests: 0 }
    ]
    const { host } = shotHost(async () => outcomes.shift() ?? SHOT)
    const shots = ofType(await watch({ shot: host }), 'shot')
    expect(shots.map((shot) => shot.pendingRequests)).toEqual([2, 0])
    expect(formatPluginDevWatchEvent(shots[0]!)).toBe(
      'shot /work/shots/acme.todos-todos.png (360x700)\n  note: 2 host call(s) were still unanswered; the panel may show its loading state'
    )
    expect(formatPluginDevWatchEvent(shots[1]!)).toBe(
      'shot /work/shots/acme.todos-todos.png (360x700)'
    )
  })
})

describe('pluginDevWatchShotPanel', () => {
  it('defaults to the first panel and checks a requested one', () => {
    expect(pluginDevWatchShotPanel(entry(0), undefined)).toBe('todos')
    expect(pluginDevWatchShotPanel(entry(0), 'stats')).toBe('stats')
    expect(() => pluginDevWatchShotPanel(entry(0), 'x')).toThrow(/no panel x/)
    expect(pluginDevWatchShotPanel({ ...entry(0), panels: [] }, undefined)).toBeNull()
    // An entry the host could not list yet cannot be checked; the host refuses a wrong id later.
    expect(pluginDevWatchShotPanel(null, 'stats')).toBe('stats')
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
