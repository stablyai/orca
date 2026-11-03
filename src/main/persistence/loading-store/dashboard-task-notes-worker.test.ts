import { describe, expect, it, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'
import type { DashboardTaskNote } from '../../../shared/dashboard-task-notes'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const key = JSON.stringify(['local', 'local', 'repo', 'folder', 'pane'])
const note: DashboardTaskNote = {
  status: 'verified',
  title: 'Worker persisted',
  summary: '',
  nextStep: '',
  owner: '',
  reviewReference: 'review.md',
  observation: '[10,20,20,"done",null]',
  savedAt: 21
}

describe('dashboard notes with the live asynchronous writer', () => {
  it('commits the private note domain before acknowledgement after the dirty set has been cleared', async () => {
    const { store, readState } = await createWorkerMaintenanceFixture()
    await store.setDashboardTaskNote({ key, note })
    expect(readState().dashboardTaskNotes).toEqual({ [key]: note })
    await store.setDashboardTaskNote({ key, note: { ...note, title: 'Second commit' } })
    expect(readState().dashboardTaskNotes[key].title).toBe('Second commit')
  })

  it('queues initial reads behind an in-flight durable save', async () => {
    const { store, authority } = await createWorkerMaintenanceFixture()
    const gate = maintenanceBarrier()
    const entered = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      entered.resolve()
      await gate.promise
      await write(domains)
    })
    const saving = store.setDashboardTaskNote({ key, note })
    await entered.promise
    let readFinished = false
    const reading = store.loadDashboardTaskNotes().then((notes) => {
      readFinished = true
      return notes
    })
    await Promise.resolve()
    expect(readFinished).toBe(false)
    gate.resolve()
    await saving
    expect(await reading).toEqual({ [key]: note })
  })

  it('rejects a failed asynchronous commit without retaining the unsaved value', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    await store.setDashboardTaskNote({ key, note })
    vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValueOnce(
      new Error('injected note commit failure')
    )
    await expect(
      store.setDashboardTaskNote({ key, note: { ...note, title: 'Unsaved' } })
    ).rejects.toThrow('injected note commit failure')
    expect(store.getDashboardTaskNotes()).toEqual({ [key]: note })
    expect(readState().dashboardTaskNotes).toEqual({ [key]: note })
  })
})
