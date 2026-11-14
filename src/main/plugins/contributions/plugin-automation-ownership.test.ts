import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import { installPluginAutomationOwnershipEnd } from './plugin-automation-ownership'
import { PluginService } from '../plugin-service'

vi.mock('electron', () => ({ ipcMain: { handle() {}, on() {} } }))

function automation(id: string, pluginKey: string, createdAt = 1): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only id, createdAt and createdBy.
  return {
    id,
    enabled: true,
    createdAt,
    createdBy: { kind: 'plugin', pluginKey, name: pluginKey }
  } as Automation
}

function automationStore(initial: Automation[]) {
  let stored = initial
  const updateAutomations = vi.fn(
    async (entries: readonly { id: string; updates: Partial<Automation> }[]) => {
      const patches = new Map(entries.map(({ id, updates }) => [id, updates]))
      stored = stored.map((entry) => ({ ...entry, ...patches.get(entry.id) }))
      return entries.map(({ id }) => ({ id, automation: stored.find((entry) => entry.id === id)! }))
    }
  )
  return {
    source: { listAutomationsForScope: () => ({ automations: stored }), updateAutomations },
    updateAutomations,
    get: (id: string) => stored.find((entry) => entry.id === id)
  }
}

// The sweep settles within a few microtasks; nothing in it waits on time.
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('automations of a plugin the person took away', () => {
  it('never ends ownership because discovery could not read the plugins folder', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orca-plugin-ownership-'))
    // A file where the plugins folder belongs: every discovery fails to list it.
    await writeFile(join(userData, 'plugins'), '')
    const service = new PluginService({
      userDataPath: userData,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({}),
      getDevPluginPaths: () => [],
      hostEntryPath: 'inert-worker-entry'
    })
    const store = automationStore([automation('a-installed', 'acme.installed')])
    try {
      installPluginAutomationOwnershipEnd(service, store.source)
      await service.initialize()
      await service.refresh()
      await settle()
      expect(service.getDiscovered()).toEqual([])
      expect(store.get('a-installed')).toMatchObject({ enabled: true })
    } finally {
      await service.dispose()
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('pauses every automation of a disabled plugin in one write', async () => {
    const store = automationStore([
      automation('a-1', 'acme.gone'),
      automation('a-2', 'acme.gone'),
      automation('a-3', 'acme.gone'),
      automation('b-1', 'acme.kept')
    ])
    installPluginAutomationOwnershipEnd(
      {
        options: {
          isPluginSystemEnabled: () => true,
          getDisabledPlugins: () => ['acme.gone']
        },
        whenReady: () => Promise.resolve(),
        onChanged: () => () => {}
      },
      store.source
    )
    await settle()
    for (const id of ['a-1', 'a-2', 'a-3']) {
      expect(store.get(id)).toMatchObject({
        enabled: false,
        createdBy: { endedAt: expect.any(Number) }
      })
    }
    expect(store.get('b-1')).toMatchObject({ enabled: true })
  })
})
