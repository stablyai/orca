import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function emptyStore() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-layout-default-tabs-'))
  directories.push(directory)
  return { store: await openTopologyStore(directory, emptyTerminalSessionProfile()), directory }
}

describe('Store.applyLayoutCommand setDefaultTabsApplied (layout.apply)', () => {
  it.each([
    ['a git worktree', FIXTURE_GIT_WORKTREE_ID],
    ['a folder workspace', FIXTURE_FOLDER_WORKTREE_ID]
  ])('records %s’s mark durably without making it a workspace', async (_kind, workspace) => {
    const { store, directory } = await emptyStore()

    const reply = await store.applyLayoutCommand({ type: 'setDefaultTabsApplied', workspace })

    expect(reply).toEqual({ ok: true, result: {} })
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.defaultTerminalTabsAppliedByWorktreeId).toEqual({ [workspace]: true })
    expect(session.tabsByWorktree[workspace]).toBeUndefined()
    expect(session.unifiedTabs?.[workspace]).toBeUndefined()
    expect(session.tabGroups?.[workspace]).toBeUndefined()
  })

  it('a repeat changes nothing', async () => {
    const { store, directory } = await emptyStore()
    const workspace = FIXTURE_GIT_WORKTREE_ID
    await store.applyLayoutCommand({ type: 'setDefaultTabsApplied', workspace })
    const reopened = await reopenTopologyStore(store, directory)
    const before = reopened.getWorkspaceSession()

    const reply = await reopened.applyLayoutCommand({ type: 'setDefaultTabsApplied', workspace })

    expect(reply).toEqual({ ok: true, result: {} })
    expect(reopened.getWorkspaceSession()).toEqual(before)
    const session = (await reopenTopologyStore(reopened, directory)).getWorkspaceSession()
    expect(session.defaultTerminalTabsAppliedByWorktreeId).toEqual({ [workspace]: true })
  })
})
