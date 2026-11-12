import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import { installPluginAutomationOwnershipEnd } from './plugin-automation-ownership'

function automation(id: string, pluginKey: string): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only id and createdBy.
  return {
    id,
    enabled: true,
    createdBy: { kind: 'plugin', pluginKey, name: pluginKey }
  } as Automation
}

function harness(state: { disabled: string[]; installed: string[]; killed: string[] }) {
  const listeners: (() => void)[] = []
  let stored = [
    automation('a-removed', 'acme.gone'),
    automation('a-disabled', 'acme.off'),
    automation('a-killed', 'acme.bad'),
    automation('a-kept', 'acme.ok'),
    automation('a-reapproval', 'acme.update')
  ]
  const updateAutomation = vi.fn(async (id: string, updates: Partial<Automation>) => {
    stored = stored.map((entry) => (entry.id === id ? { ...entry, ...updates } : entry))
    return stored.find((entry) => entry.id === id)!
  })
  installPluginAutomationOwnershipEnd(
    {
      options: {
        isPluginSystemEnabled: () => true,
        getDisabledPlugins: () => state.disabled,
        getPluginKillListEntry: (key) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only presence is read.
          state.killed.includes(key) ? ({ reason: 'blocked' } as never) : null
      },
      getDiscovered: () => state.installed.map((pluginKey) => ({ pluginKey })),
      onChanged: (listener) => {
        listeners.push(listener)
        return () => undefined
      }
    },
    { listAutomationsForScope: () => ({ automations: stored }), updateAutomation }
  )
  const change = async () => {
    listeners.forEach((listener) => listener())
    // The sweep settles within a few microtasks; nothing in it waits on time.
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { change, updateAutomation, stored: () => stored }
}

describe('automations of a plugin the person took away', () => {
  it('are paused and no longer its own; re-enabling it resumes nothing', async () => {
    const state = {
      // acme.update waits for re-approval of a new version: still installed, not disabled.
      installed: ['acme.off', 'acme.bad', 'acme.ok', 'acme.update'],
      disabled: ['acme.off'],
      killed: ['acme.bad']
    }
    const { change, updateAutomation, stored } = harness(state)
    await change()
    const ended = (id: string) => stored().find((entry) => entry.id === id)
    for (const id of ['a-removed', 'a-disabled', 'a-killed']) {
      expect(ended(id)).toMatchObject({
        enabled: false,
        createdBy: { endedAt: expect.any(Number) }
      })
    }
    for (const id of ['a-kept', 'a-reapproval']) {
      expect(ended(id)?.enabled).toBe(true)
      expect(ended(id)?.createdBy?.endedAt).toBeUndefined()
    }
    updateAutomation.mockClear()
    state.disabled = []
    state.installed.push('acme.gone')
    await change()
    expect(updateAutomation).not.toHaveBeenCalled()
    expect(ended('a-disabled')).toMatchObject({ enabled: false })
  })
})
