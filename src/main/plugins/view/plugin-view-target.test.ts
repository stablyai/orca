import { describe, expect, it } from 'vitest'
import type {
  PluginHostListEntry,
  PluginHostStatus
} from '../../../shared/plugins/plugin-list-entry'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import {
  resolvePluginViewEditor,
  resolvePluginViewPanel,
  type PluginViewSource
} from './plugin-view-target'

const KEY = 'acme.todos'

function source(
  status: PluginHostStatus,
  contributes: { panels?: unknown[]; customEditors?: unknown[] } = {}
): PluginViewSource {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only pluginKey, status and error.
  const entry = { pluginKey: KEY, status, error: 'boom' } as PluginHostListEntry
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only rootDir, contentHash and these contributions.
  const plugin = {
    pluginKey: KEY,
    rootDir: '/plugins/acme.todos',
    contentHash: `sha256-${'a'.repeat(64)}`,
    manifest: {
      contributes: {
        panels: contributes.panels ?? [],
        customEditors: contributes.customEditors ?? []
      }
    }
  } as unknown as ValidDiscoveredPlugin
  return {
    list: async () => [entry],
    findValidPlugin: (key) => (key === KEY ? plugin : null)
  }
}

const PANELS = [
  { id: 'todos', title: 'Todos', entry: 'src/panel.tsx', ui: 'components' },
  { id: 'stats', title: 'Stats', entry: 'stats.html' }
]

describe('resolvePluginViewPanel', () => {
  it('defaults to the first panel and stamps the guest revision', async () => {
    await expect(
      resolvePluginViewPanel(source('idle', { panels: PANELS }), KEY, undefined)
    ).resolves.toEqual({
      pluginKey: KEY,
      panelId: 'todos',
      title: 'Todos',
      ui: 'components',
      guestRevision: 'sha256-aaaaaaaaa'
    })
    await expect(
      resolvePluginViewPanel(source('running', { panels: PANELS }), KEY, 'stats')
    ).resolves.toMatchObject({ panelId: 'stats', ui: 'html' })
  })

  it('names the panels it has when the id is wrong', async () => {
    await expect(
      resolvePluginViewPanel(source('idle', { panels: PANELS }), KEY, 'nope')
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: { nextSteps: ['Its panels: todos, stats.'] }
    })
    await expect(resolvePluginViewPanel(source('idle'), KEY, undefined)).rejects.toThrow(
      /contributes no panels/
    )
  })

  it('refuses an unknown plugin and one that is not running', async () => {
    await expect(
      resolvePluginViewPanel(source('idle', { panels: PANELS }), 'acme.other', undefined)
    ).rejects.toMatchObject({ code: 'plugin_not_found' })
    await expect(
      resolvePluginViewPanel(source('pending', { panels: PANELS }), KEY, undefined)
    ).rejects.toThrow(/waiting for approval/)
    await expect(
      resolvePluginViewPanel(source('errored', { panels: PANELS }), KEY, undefined)
    ).rejects.toThrow(/is errored: boom/)
  })
})

describe('resolvePluginViewEditor', () => {
  const editors = [{ id: 'notes', title: 'Notes', extensions: ['.notes'], filenames: [] }]

  it('picks the first editor that takes the file', async () => {
    await expect(
      resolvePluginViewEditor(source('idle', { customEditors: editors }), KEY, '/w/plan.notes')
    ).resolves.toEqual({ pluginKey: KEY, editorId: 'notes', title: 'Notes' })
  })

  it('says which files its editors open when none takes this one', async () => {
    await expect(
      resolvePluginViewEditor(source('idle', { customEditors: editors }), KEY, '/w/plan.md')
    ).rejects.toMatchObject({ data: { nextSteps: ['notes opens *.notes.'] } })
    await expect(resolvePluginViewEditor(source('idle'), KEY, '/w/a.md')).rejects.toThrow(
      /no custom editors/
    )
  })
})
