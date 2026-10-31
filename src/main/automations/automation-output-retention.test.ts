import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import {
  closeTestStores,
  createStore,
  testState,
  writePersistedStateJson
} from '../persistence/persistence-test-harness'
import { createAutomationRunWriter } from './automation-run-writer'
import {
  automationRunOutputsRoot,
  writeAutomationRunOutputFile
} from './automation-run-output-files'
import { RuntimeAutomationController } from '../runtime/runtime-automation-controller'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-output-retention-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function fixture() {
  const state = buildProfileStateCutoverFixture(testState.dir)
  const automation = state.automations[0]
  const run = state.automationRuns[0]
  state.automationRuns = Array.from({ length: 101 }, (_, index) => ({
    ...run,
    id: `run-${index}`,
    status: 'completed' as const,
    createdAt: index,
    scheduledFor: index
  }))
  writePersistedStateJson(join(testState.dir, 'orca-data.json'), JSON.stringify(state))
  const store = createStore()
  const completed = store.createAutomationRun(automation, Date.now() - 1)
  store.updateAutomationRun({ runId: completed.id, status: 'completed' })
  const retained = store.listAutomationRuns(automation.id)
  for (const entry of retained) {
    writeAutomationRunOutputFile(
      automationRunOutputsRoot(),
      entry,
      { id: 'output', format: 'markdown' },
      '# Report'
    )
  }
  const path = (id: string) => join(automationRunOutputsRoot(), automation.id, id)
  return { store, automation, retained, path }
}

describe('durable automation output retention', () => {
  it('removes pruned output directories only after acknowledging creation', async () => {
    const { store, automation, retained, path } = fixture()
    const acknowledgement = Promise.withResolvers<void>()
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockReturnValueOnce(acknowledgement.promise)
    const pending = createAutomationRunWriter(store, null).createRun(automation, Date.now())
    const kept = new Set(store.listAutomationRuns(automation.id).map((run) => run.id))
    const pruned = retained.filter((run) => !kept.has(run.id))
    expect(pruned.length).toBeGreaterThan(0)
    expect(pruned.every((run) => existsSync(path(run.id)))).toBe(true)

    acknowledgement.resolve()
    await pending
    expect(pruned.some((run) => existsSync(path(run.id)))).toBe(false)
    expect(
      retained.filter((run) => kept.has(run.id)).every((run) => existsSync(path(run.id)))
    ).toBe(true)
  })

  it.each([true, false])(
    'cleans deleted automation outputs only when persistence succeeds: %s',
    async (succeeds) => {
      const { store, automation, retained, path } = fixture()
      const acknowledgement = Promise.withResolvers<void>()
      vi.spyOn(store, 'flushPendingOrThrowAsync').mockReturnValueOnce(acknowledgement.promise)
      const controller = new RuntimeAutomationController(store, {
        showRepo: async () => {
          throw new Error('Unused resolver')
        },
        showManagedWorktree: async () => {
          throw new Error('Unused resolver')
        }
      })
      writeAutomationRunOutputFile(
        automationRunOutputsRoot(),
        { automationId: automation.id, id: 'orphan' },
        { id: 'output', format: 'markdown' },
        '# Orphan'
      )
      const pending = controller.delete(automation.id)
      expect(retained.every((run) => existsSync(path(run.id)))).toBe(true)
      if (succeeds) {
        acknowledgement.resolve()
        await pending
      } else {
        acknowledgement.reject(new Error('disk full'))
        await expect(pending).rejects.toThrow('disk full')
      }
      expect(retained.every((run) => existsSync(path(run.id)))).toBe(!succeeds)
      expect(existsSync(path('orphan'))).toBe(!succeeds)
    }
  )
})
