import { describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../shared/plugins/plugin-list-entry'
import type { PluginDevWatchCheckResult } from './plugin-dev-watch-check'
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
  ],
  editors: []
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
})
