import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { CLIENT_UI_METHODS } from '../../runtime/rpc/methods/client-ui'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-notes-pairing-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('keeps profile notes out of UI/settings/pairing projections and rejects remote note writes', async () => {
  const store = createStore()
  const key = JSON.stringify(['local', 'local', 'repo', 'folder', 'pane'])
  const note = {
    status: 'automatic' as const,
    title: 'PRIVATE_NOTE_SENTINEL',
    summary: '',
    nextStep: '',
    owner: '',
    reviewReference: '',
    observation: '',
    savedAt: 1
  }
  await store.setDashboardTaskNote({ key, note })
  const runtime = {
    getRuntimeId: () => 'synthetic-runtime',
    getUIState: () => store.getUI(),
    getClientSettings: () => store.getSettings(),
    updateUIState: (updates: Partial<PersistedUIState>) => {
      store.updateUI(updates)
      return store.getUI()
    }
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these RPCs use only the supplied synthetic runtime surface.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: CLIENT_UI_METHODS
  })
  for (const method of ['ui.get', 'settings.get', 'ui.set']) {
    const response = await dispatcher.dispatch({
      id: 'notes-test',
      authToken: 'synthetic',
      method,
      ...(method === 'ui.set' ? { params: { sidebarWidth: 320 } } : {})
    })
    expect(response).toMatchObject({ ok: true })
    expect(JSON.stringify(response)).not.toContain('dashboardTaskNotes')
    expect(JSON.stringify(response)).not.toContain('PRIVATE_NOTE_SENTINEL')
  }
  const rejected = await dispatcher.dispatch({
    id: 'notes-write',
    authToken: 'synthetic',
    method: 'ui.set',
    params: { dashboardTaskNotes: {} }
  })
  expect(rejected).toMatchObject({ ok: false })
  expect(store.getDashboardTaskNotes()).toEqual({ [key]: note })
})
