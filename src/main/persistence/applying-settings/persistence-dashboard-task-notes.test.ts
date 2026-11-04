import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MAX_DASHBOARD_TASK_NOTES,
  type DashboardTaskNote
} from '../../../shared/dashboard-task-notes'
import { getDefaultPersistedState } from '../../../shared/constants'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import {
  closeTestStores,
  createStore,
  testState,
  writeDataFile,
  readPersistedState
} from '../persistence-test-harness'

const note: DashboardTaskNote = {
  status: 'verified',
  title: 'Reviewed task',
  summary: '',
  nextStep: '',
  owner: '',
  reviewReference: 'review.md',
  observation: '[10,20,20,"done",null]',
  savedAt: 21
}
const key = (pane: string): string => JSON.stringify(['local', 'local', 'repo', 'worktree', pane])

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-notes-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('profile dashboard task notes', () => {
  it('durably merges concurrent keys, survives store restart and stays out of generic UI sync', async () => {
    const store = createStore()
    await Promise.all([
      store.setDashboardTaskNote({ key: key('main'), note }),
      store.setDashboardTaskNote({ key: key('popout'), note: { ...note, title: 'Popout task' } })
    ])
    store.updateUI({ sidebarWidth: 321 })
    expect(store.getUI()).not.toHaveProperty('dashboardTaskNotes')
    store.flushOrThrow()
    await closeTestStores()
    const restarted = createStore()
    expect(restarted.getDashboardTaskNotes()).toEqual({
      [key('main')]: note,
      [key('popout')]: { ...note, title: 'Popout task' }
    })
    expect(restarted.getUI().sidebarWidth).toBe(321)
  })

  it('keeps private notes across a full profile export and unrelated UI changes', async () => {
    const store = createStore()
    await store.setDashboardTaskNote({ key: key('private'), note })
    const exported = JSON.parse(store.prepareProfileStateExport().json)
    expect(exported.dashboardTaskNotes).toEqual({ [key('private')]: note })
    expect(exported.ui).not.toHaveProperty('dashboardTaskNotes')
    expect(exported.settings).not.toHaveProperty('dashboardTaskNotes')
    await closeTestStores()
    exported.ui.sidebarWidth = 333
    writeDataFile(exported)
    const reopened = createStore()
    reopened.updateSettings({ theme: 'dark' })
    reopened.flushOrThrow()
    expect(reopened.getDashboardTaskNotes()).toEqual({ [key('private')]: note })
    expect(reopened.getUI().sidebarWidth).toBe(333)
    expect(readPersistedState().dashboardTaskNotes).toEqual({ [key('private')]: note })
  })

  it('imports missing legacy keys without replacing a concurrent save', async () => {
    const store = createStore()
    const current = { ...note, title: 'Current' }
    const [saved, imported] = await Promise.all([
      store.setDashboardTaskNote({ key: key('same'), note: current }),
      store.setDashboardTaskNote({ key: key('same'), note, mode: 'import-if-missing' })
    ])
    expect(imported).toEqual(saved)
    expect(store.getDashboardTaskNotes()[key('same')]).toEqual(current)
  })

  it('rejects invalid input without freezing valid future writes', async () => {
    const store = createStore()
    await expect(store.setDashboardTaskNote({ key: '__proto__', note })).rejects.toThrow()
    await expect(
      store.setDashboardTaskNote({ key: key('bad'), note: { ...note, title: 'x'.repeat(121) } })
    ).rejects.toThrow()
    await store.setDashboardTaskNote({ key: key('good'), note })
    expect(Object.keys(store.getDashboardTaskNotes())).toEqual([key('good')])
  })

  it('limits growth while still allowing an existing note to change', async () => {
    const state = getDefaultPersistedState(testState.dir)
    state.dashboardTaskNotes = Object.fromEntries(
      Array.from({ length: MAX_DASHBOARD_TASK_NOTES }, (_, i) => [key(String(i)), note])
    )
    writeDataFile(state)
    const store = createStore()
    await expect(store.setDashboardTaskNote({ key: key('extra'), note })).rejects.toThrow('limit')
    await store.setDashboardTaskNote({ key: key('0'), note: { ...note, title: 'Updated' } })
    expect(store.getDashboardTaskNotes()[key('0')].title).toBe('Updated')
  })

  it('does not acknowledge or retain an unsaved note after a definite disk failure', async () => {
    const store = createStore()
    await store.setDashboardTaskNote({ key: key('saved'), note })
    vi.spyOn(
      ProfileStateSqliteAuthority.prototype,
      'writeSerializedDomains'
    ).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(store.setDashboardTaskNote({ key: key('unsaved'), note })).rejects.toThrow(
      'disk full'
    )
    expect(store.getDashboardTaskNotes()).toEqual({ [key('saved')]: note })
  })
})
