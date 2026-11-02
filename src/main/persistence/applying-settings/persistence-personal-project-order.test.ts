import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { mutatePersonalProjectOrder } from '../../../shared/personal-project-order-writes'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-project-order-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('persisted personal project preferences', () => {
  it('keeps counters, pins and retry dedupe in the actual profile database across restart', async () => {
    const store = createStore()
    const runtime = {
      getUIState: () => store.getUI(),
      updateUIState: (updates: Parameters<typeof store.updateUI>[0]) => {
        store.updateUI(updates)
        return store.getUI()
      }
    }
    const open = {
      projectKey: 'github:alpha',
      previousProjectKey: 'github:beta',
      opId: { writer: 'phone', seq: 1 }
    }
    mutatePersonalProjectOrder(runtime, open)
    mutatePersonalProjectOrder(runtime, {
      projectKey: 'github:alpha',
      pinned: true,
      opId: { writer: 'desktop', seq: 1 }
    })
    store.updateUI({ projectOrderBy: 'frequent', sidebarWidth: 280 })
    store.flush()
    await closeTestStores()
    const reopened = createStore()
    expect(reopened.getUI()).toMatchObject({
      projectOrderBy: 'frequent',
      personalProjectOrder: { projects: { 'github:alpha': { pinned: true, openCount: 1 } } }
    })
    const restarted = {
      getUIState: () => reopened.getUI(),
      updateUIState: (updates: Parameters<typeof reopened.updateUI>[0]) => {
        reopened.updateUI(updates)
        return reopened.getUI()
      }
    }
    expect(mutatePersonalProjectOrder(restarted, open).applied).toBe(false)
    expect(reopened.getUI().personalProjectOrder?.projects['github:alpha'].openCount).toBe(1)
  })

  it('keeps valid pins and unrelated summaries when persisted numeric fields are invalid', () => {
    const store = createStore()
    store.updateUI({
      personalProjectOrder: JSON.parse(
        JSON.stringify({
          projects: {
            'github:alpha': { pinned: true, openCount: -1, lastOpenedAt: 1.5 },
            'github:beta': { openCount: 8, lastOpenedAt: 500 }
          },
          settledOperations: []
        })
      )
    })
    expect(store.getUI().personalProjectOrder?.projects).toEqual({
      'github:alpha': { pinned: true },
      'github:beta': { openCount: 8, lastOpenedAt: 500 }
    })
  })
})
