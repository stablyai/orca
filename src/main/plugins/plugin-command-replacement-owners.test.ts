import { describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import type { PluginLockfile } from '../../shared/plugins/installation/plugin-install-lockfile'
import { markCommandReplacementOwners } from './plugin-command-replacement-owners'

function entry(
  pluginKey: string,
  status: PluginHostListEntry['status'] = 'idle'
): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: null,
    name: pluginKey,
    version: '1.0.0',
    publisher: 'acme',
    status,
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [
      {
        id: 'tasks',
        title: 'Tasks',
        context: 'global',
        handler: { type: 'worker' },
        keybindings: [],
        replaces: 'view.tasks'
      }
    ],
    hasWorker: true,
    restarts: 0
  }
}

function lock(times: Record<string, number>): Pick<PluginLockfile, 'plugins'> {
  const plugins = Object.fromEntries(
    Object.entries(times).map(([key, installedAt]) => [key, { installedAt }])
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owners read only installedAt.
  return { plugins } as unknown as Pick<PluginLockfile, 'plugins'>
}

describe('who replaces a built-in action', () => {
  it('lets the plugin installed first replace it, marks and logs the other once', () => {
    const log = vi.fn()
    const entries = [entry('acme.later'), entry('acme.first'), entry('acme.dev')]
    const marked = markCommandReplacementOwners(
      entries,
      lock({ 'acme.first': 1, 'acme.later': 2 }),
      log
    )
    expect(marked.map((each) => each.commands[0]?.replacedBy)).toEqual([
      'acme.first',
      undefined,
      'acme.first'
    ])
    expect(log).toHaveBeenCalledWith(
      'acme.later',
      'command tasks does not replace view.tasks: acme.first was installed first and replaces it'
    )
    markCommandReplacementOwners(entries, lock({ 'acme.first': 1, 'acme.later': 2 }), log)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('ignores plugins that are off', () => {
    const marked = markCommandReplacementOwners(
      [entry('acme.first', 'disabled'), entry('acme.later')],
      lock({ 'acme.first': 1, 'acme.later': 2 }),
      vi.fn()
    )
    expect(marked[1]?.commands[0]?.replacedBy).toBeUndefined()
  })
})
