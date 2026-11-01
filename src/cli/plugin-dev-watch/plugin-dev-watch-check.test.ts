import { describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import {
  createPluginDevWatchCheckQueue,
  type PluginDevWatchCheckResult
} from './plugin-dev-watch-check'
import { formatPluginDevWatchEvent, type PluginDevWatchEvent } from './plugin-dev-watch-events'
import { runPluginDevWatch, type PluginDevWatchHost } from './plugin-dev-watch-loop'

const KEY = 'acme.todos'

function entry(
  devChangeCount: number,
  status: PluginHostListEntry['status'] = 'idle'
): PluginHostListEntry {
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

const passed: PluginDevWatchCheckResult = {
  ok: true,
  invalid: [],
  panels: [
    {
      panel: 'todos',
      entry: 'src/panel.tsx',
      elements: 12,
      summary: ['Heading "Tasks"'],
      issues: [],
      warnings: []
    }
  ]
}
const failed: PluginDevWatchCheckResult = {
  ok: false,
  invalid: [],
  panels: [
    {
      panel: 'todos',
      entry: 'src/panel.tsx',
      elements: 0,
      summary: [],
      issues: [{ kind: 'plugin', message: 'boom', location: 'src/panel.tsx:4:7' }],
      warnings: []
    }
  ]
}

/** Polls: 1 baseline, 2 status (unchanged), 3 logs, 4 status (one save), then Ctrl-C. */
async function watch(
  check: PluginDevWatchHost['check'],
  lists = [[entry(0)], [entry(1)]]
): Promise<PluginDevWatchEvent[]> {
  const events: PluginDevWatchEvent[] = []
  let interrupt = () => {}
  let poll = 0
  const host: PluginDevWatchHost = {
    refreshTypes: async () => [],
    devLoad: async () => ({
      path: '/work/todos',
      pluginKey: KEY,
      added: true,
      approval: 'approve-flag',
      plugin: entry(0)
    }),
    list: async () => (lists.length > 1 ? lists.shift() : lists[0]) ?? [entry(1)],
    logs: async () => ({ pluginKey: KEY, lines: [] }),
    approvalNeeded: async () => null,
    devUnload: async () => {},
    check
  }
  await runPluginDevWatch({
    host,
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

describe('plugin dev watch --check', () => {
  it('checks after the load and after each reload, before the unload line', async () => {
    const check = vi.fn<NonNullable<PluginDevWatchHost['check']>>()
    check.mockResolvedValueOnce(passed).mockResolvedValueOnce(failed)
    const events = await watch(check)
    expect(check).toHaveBeenCalledTimes(2)
    const types = events.map((event) => event.type)
    expect(types[0]).toBe('loaded')
    expect(types.filter((type) => type === 'check')).toHaveLength(2)
    expect(types.indexOf('check', types.indexOf('reloaded'))).toBeGreaterThan(-1)
    expect(types.at(-1)).toBe('unloaded')
    const last = events.findLast((event) => event.type === 'check')
    expect(last && formatPluginDevWatchEvent(last)).toBe(
      '✗ check failed for acme.todos\n  todos (src/panel.tsx): failed\n    src/panel.tsx:4:7: boom'
    )
  })

  it('fails a check that renders while Orca does not run the plugin', async () => {
    const pending = entry(1, 'pending')
    const events = await watch(vi.fn().mockResolvedValue(passed), [[entry(0)], [pending]])
    const checks = events.filter((event) => event.type === 'check')
    expect(checks.map((event) => [event.ok, event.checkOk, event.pluginStatus])).toEqual([
      [true, true, 'idle'],
      [false, true, 'pending']
    ])
    expect(formatPluginDevWatchEvent(checks[1]).split('\n')[0]).toBe(
      '✗ check passed, but in Orca acme.todos is pending approval'
    )
  })

  it('reports a check that cannot run as a warning and keeps watching', async () => {
    const events = await watch(async () => {
      throw new Error('no node')
    })
    expect(events).toContainEqual({ type: 'warning', message: 'check could not run: no node' })
    expect(events.at(-1)?.type).toBe('unloaded')
  })

  it('does not check without --check', async () => {
    const events = await watch(undefined)
    expect(events.some((event) => event.type === 'check')).toBe(false)
  })
})

describe('createPluginDevWatchCheckQueue', () => {
  it('runs one check at a time and folds requests made meanwhile into one rerun', async () => {
    const releases: (() => void)[] = []
    const run = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)))
    const queue = createPluginDevWatchCheckQueue(run)
    queue.request()
    queue.request()
    queue.request()
    expect(run).toHaveBeenCalledTimes(1)
    releases.shift()?.()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    releases.shift()?.()
    await queue.idle()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
