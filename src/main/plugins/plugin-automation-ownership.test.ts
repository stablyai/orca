import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import { installPluginAutomationOwnershipEnd } from './plugin-automation-ownership'
import { notifyPluginRemoved } from './installation/plugin-removal-events'
import { PluginService } from './plugin-service'

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
  const updateAutomation = vi.fn(async (id: string, updates: Partial<Automation>) => {
    stored = stored.map((entry) => (entry.id === id ? { ...entry, ...updates } : entry))
    return stored.find((entry) => entry.id === id)!
  })
  return {
    source: { listAutomationsForScope: () => ({ automations: stored }), updateAutomation },
    updateAutomation,
    get: (id: string) => stored.find((entry) => entry.id === id)
  }
}

// The sweep settles within a few microtasks; nothing in it waits on time.
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('automations of a plugin the person took away', () => {
  it('are paused and no longer its own; re-enabling it resumes nothing', async () => {
    const settings = { disabled: ['acme.off'], killed: ['acme.bad'] }
    const listeners: (() => void)[] = []
    const store = automationStore([
      automation('a-removed', 'acme.gone'),
      automation('a-disabled', 'acme.off'),
      automation('a-killed', 'acme.bad'),
      automation('a-kept', 'acme.ok')
    ])
    installPluginAutomationOwnershipEnd(
      {
        options: {
          isPluginSystemEnabled: () => true,
          getDisabledPlugins: () => settings.disabled,
          getPluginKillListEntry: (key) =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only presence is read.
            settings.killed.includes(key) ? ({ reason: 'blocked' } as never) : null
        },
        whenReady: async () => undefined,
        onChanged: (listener) => {
          listeners.push(listener)
          return () => undefined
        }
      },
      store.source
    )
    notifyPluginRemoved('acme.gone')
    await settle()
    for (const id of ['a-removed', 'a-disabled', 'a-killed']) {
      expect(store.get(id)).toMatchObject({
        enabled: false,
        createdBy: { endedAt: expect.any(Number) }
      })
    }
    expect(store.get('a-kept')?.createdBy?.endedAt).toBeUndefined()

    store.updateAutomation.mockClear()
    settings.disabled = []
    listeners.forEach((listener) => listener())
    await settle()
    expect(store.updateAutomation).not.toHaveBeenCalled()
    expect(store.get('a-disabled')?.enabled).toBe(false)
  })

  it('keeps what a reinstall under the same key creates after the removal', async () => {
    // Created after any removal time the test can record.
    const store = automationStore([automation('a-new', 'acme.again', Number.MAX_SAFE_INTEGER)])
    installPluginAutomationOwnershipEnd(
      {
        options: { isPluginSystemEnabled: () => true, getDisabledPlugins: () => [] },
        whenReady: async () => undefined,
        onChanged: () => () => undefined
      },
      store.source
    )
    notifyPluginRemoved('acme.again')
    await settle()
    expect(store.updateAutomation).not.toHaveBeenCalled()
  })

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
      expect(store.updateAutomation).not.toHaveBeenCalled()
      expect(store.get('a-installed')).toMatchObject({ enabled: true })
    } finally {
      await service.dispose()
      await rm(userData, { recursive: true, force: true })
    }
  })
})
