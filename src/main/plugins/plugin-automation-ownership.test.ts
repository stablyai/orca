import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import { installPluginAutomationOwnershipEnd } from './plugin-automation-ownership'
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
