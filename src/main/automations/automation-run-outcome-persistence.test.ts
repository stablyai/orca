import { describe, expect, it, vi } from 'vitest'
import { createAutomationRunWriter } from './automation-run-writer'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

async function runningFixture() {
  const result = await fixture()
  const automation = result.store.listAutomations()[0]
  const run = result.store.createAutomationRun(automation, Date.now(), 'manual')
  result.store.updateAutomationRun({ runId: run.id, status: 'dispatched' })
  await result.store.flushPendingOrThrowAsync()
  const publish = vi.fn()
  const writer = createAutomationRunWriter(result.store, publish)
  return { ...result, run, publish, writer }
}

describe('durable automation outcome publication', () => {
  it('retains a failed-flush intent until an unrelated commit saves it', async () => {
    const { store, authority, run, publish, writer, readState } = await runningFixture()
    const restore = [
      vi
        .spyOn(authority, 'writeSerializedAutomationRuns')
        .mockRejectedValue(new Error('disk full')),
      vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValue(new Error('disk full')),
      vi
        .spyOn(authority, 'writeCompleteSerializedDomains')
        .mockRejectedValue(new Error('disk full')),
      vi.spyOn(authority, 'writeSerializedState').mockRejectedValue(new Error('disk full'))
    ]
    await expect(writer.updateRun({ runId: run.id, status: 'dispatch_failed' })).rejects.toThrow(
      'disk full'
    )
    expect(
      publish.mock.calls.flatMap(([event]) => (event.settledRun ? [event.settledRun] : []))
    ).toEqual([])
    expect(readState().automationRuns.find((row: { id: string }) => row.id === run.id).status).toBe(
      'dispatched'
    )

    for (const spy of restore) {
      spy.mockRestore()
    }
    store.updateUI({ activeView: 'automations' })
    await store.flushPendingOrThrowAsync()
    expect(readState().automationRuns.find((row: { id: string }) => row.id === run.id).status).toBe(
      'dispatch_failed'
    )
    expect(
      publish.mock.calls.flatMap(([event]) =>
        event.settledRun ? [event.settledRun.run.status] : []
      )
    ).toEqual(['dispatch_failed'])
    await writer.updateRun({ runId: run.id, status: 'dispatch_failed', terminalPtyId: null })
    expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(1)
    writer.dispose()
  })

  it('keeps the captured outcome through a concurrent final-row metadata rewrite', async () => {
    const { store, authority, run, publish, writer } = await runningFixture()
    const gate = authority.pause()
    const final = writer.updateRun({ runId: run.id, status: 'completed' })
    await gate.started.promise
    const metadata = writer.updateRun({ runId: run.id, status: 'completed', terminalPtyId: null })
    expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(0)
    gate.finish.resolve()
    await Promise.all([final, metadata])
    const outcomes = publish.mock.calls.flatMap(([event]) =>
      event.settledRun ? [event.settledRun] : []
    )
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].run).toMatchObject({ id: run.id, status: 'completed' })
    expect(store.listAutomationRuns().find((row) => row.id === run.id)?.terminalPtyId).toBeNull()
    writer.dispose()
  })

  it.each(['deleted', 'disposed'] as const)(
    'releases a pending intent when %s',
    async (release) => {
      const { store, authority, run, publish, writer } = await runningFixture()
      const restore = [
        vi
          .spyOn(authority, 'writeSerializedAutomationRuns')
          .mockRejectedValue(new Error('disk full')),
        vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValue(new Error('disk full')),
        vi
          .spyOn(authority, 'writeCompleteSerializedDomains')
          .mockRejectedValue(new Error('disk full')),
        vi.spyOn(authority, 'writeSerializedState').mockRejectedValue(new Error('disk full'))
      ]
      await expect(writer.updateRun({ runId: run.id, status: 'dispatch_failed' })).rejects.toThrow(
        'disk full'
      )
      for (const spy of restore) {
        spy.mockRestore()
      }
      if (release === 'deleted') {
        store.deleteAutomation(run.automationId)
      } else {
        writer.dispose()
      }
      await store.flushPendingOrThrowAsync()
      expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(0)
      writer.dispose()
    }
  )
})
