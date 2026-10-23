// A window-owned build: main's Store keeps no editor tab view, the window owns them.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { WindowSession } from '../persistence/terminal-topology/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID as WT,
  openTopologyStore
} from '../persistence/terminal-topology/terminal-topology-profile-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('keeps no view for a diff tab a layout command opens', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-editor-view-off-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(WT, 'term-1', '11111111-1111-4111-8111-111111111111')
  store.setWorkspaceSession(window.snapshot())

  const opened = await store.applyLayoutCommand({
    type: 'openEditorTab',
    workspace: WT,
    tabId: 'd1',
    fileId: 'diff::unstaged::/fixture/local/a.ts',
    contentType: 'diff',
    groupId: `group-${WT}`,
    view: {
      view: { mode: 'diff', diffSource: 'unstaged' },
      file: { filePath: '/fixture/local/a.ts', relativePath: 'a.ts', language: 'typescript' }
    }
  })

  expect(opened.ok).toBe(true)
  expect(store.getWorkspaceSession().unifiedTabs?.[WT]).toContainEqual(
    expect.objectContaining({ id: 'd1' })
  )
  expect(store.getLayoutEditorViews('local')).toBeUndefined()
  await store.freezeWritesAsync()
})
