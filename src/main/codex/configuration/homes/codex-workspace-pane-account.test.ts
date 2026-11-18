import { afterEach, beforeEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../../../codex-accounts/runtime-home/runtime-home-service-test-harness'
import { createSettings } from '../../../codex-accounts/runtime-home/runtime-home-settings-test-fixtures'
import { recordCodexPaneAccountForSpawn } from '../../../ipc/pty/host-env/codex-home'
import { listStaleCodexPanes } from './codex-stale-pane-accounts'

beforeEach(() => {
  setupRuntimeHomeTest()
  installFakeAppEnvironment({ getPath: () => testState.userDataDir })
})
afterEach(() => teardownRuntimeHomeTest())

it('records the launched workspace home and keeps its pane current when only the host default changes', () => {
  const settings = createSettings({
    codexManagedAccounts: ['personal', 'work'].map((id) => ({
      id,
      email: `${id}@example.com`,
      managedHomePath: join(testState.userDataDir, id),
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    activeCodexManagedAccountId: 'personal',
    activeCodexManagedAccountIdsByRuntime: { host: 'personal', wsl: {} },
    codexWorkspaceAccounts: { 'folder:client': 'work' }
  })
  recordCodexPaneAccountForSpawn({
    ptyId: 'workspace-pane',
    workspaceId: 'folder:client',
    isDaemonHostSpawn: true,
    isReattach: false,
    pinnedByResume: false,
    launchCodexHomePath: join(testState.userDataDir, 'work'),
    target: { runtime: 'host' },
    settings
  })
  expect(listStaleCodexPanes({ ptyIds: ['workspace-pane'], settings })).toEqual([])
  settings.activeCodexManagedAccountId = null
  settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
  expect(listStaleCodexPanes({ ptyIds: ['workspace-pane'], settings })).toEqual([])
  settings.codexWorkspaceAccounts = { 'folder:client': 'personal' }
  expect(listStaleCodexPanes({ ptyIds: ['workspace-pane'], settings })).toEqual([
    { ptyId: 'workspace-pane', launchAccountId: 'work', activeAccountId: 'personal' }
  ])
})

it('detects a new workspace binding for an inherited pane and ignores runtime-mismatched bindings', () => {
  const settings = createSettings({
    codexManagedAccounts: ['personal', 'work', 'guest'].map((id) => ({
      id,
      email: `${id}@example.com`,
      managedHomePath: join(testState.userDataDir, id),
      ...(id === 'guest' ? { managedHomeRuntime: 'wsl' as const, wslDistro: 'Ubuntu' } : {}),
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    activeCodexManagedAccountId: 'personal',
    activeCodexManagedAccountIdsByRuntime: { host: 'personal', wsl: {} },
    codexWorkspaceAccounts: {}
  })
  recordCodexPaneAccountForSpawn({
    ptyId: 'inherited',
    workspaceId: 'folder:client',
    isDaemonHostSpawn: true,
    isReattach: false,
    pinnedByResume: false,
    launchCodexHomePath: join(testState.userDataDir, 'personal'),
    target: { runtime: 'host' },
    settings
  })
  settings.codexWorkspaceAccounts = { 'folder:client': 'work' }
  expect(listStaleCodexPanes({ ptyIds: ['inherited'], settings })).toEqual([
    { ptyId: 'inherited', launchAccountId: 'personal', activeAccountId: 'work' }
  ])
  settings.codexWorkspaceAccounts = { 'folder:client': 'guest' }
  expect(listStaleCodexPanes({ ptyIds: ['inherited'], settings })).toEqual([])
})
