import type * as NodeCrypto from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LAYOUT_OWNER_WRITTEN_SESSION_GOLDEN_PATH,
  LAYOUT_OWNER_WRITTEN_SESSION_WORKTREE_ID as WORKTREE
} from '../../../shared/__fixtures__/layout-owner-written-session-golden-paths'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { windowViewSaveForMain } from '../window-save-view'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
// Ids main mints while it applies the commands are numbered, so the written bytes are stable.
const minting = vi.hoisted(() => ({ on: false, next: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return {
    ...actual,
    randomUUID: () =>
      minting.on
        ? `00000000-0000-4000-8000-${String(++minting.next).padStart(12, '0')}`
        : actual.randomUUID()
  }
})

const UPDATE_ENV = 'ORCA_UPDATE_LAYOUT_OWNER_GOLDEN'
const leaf = (n: number): string => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`
const on = { workspace: WORKTREE }
const directories: string[] = []

afterEach(() => {
  minting.on = false
  vi.useRealTimers()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Two groups, a split, an editor file, a browser tab, a renamed tab and a closed tab. */
const COMMANDS: LayoutCommand[] = [
  { ...on, type: 'createTerminalTab', tabId: 'tab-shell', leafId: leaf(1), createdAt: 1 },
  { ...on, type: 'createTerminalTab', tabId: 'tab-build', leafId: leaf(2), createdAt: 2 },
  {
    ...on,
    type: 'splitPane',
    tabId: 'tab-shell',
    leafId: leaf(1),
    direction: 'vertical',
    newLeafId: leaf(3)
  },
  { ...on, type: 'renameTab', tabId: 'tab-build', kind: 'custom', title: 'Build' },
  {
    ...on,
    type: 'openEditorTab',
    tabId: 'tab-readme',
    fileId: '/fixture/local/README.md',
    contentType: 'editor',
    createdAt: 3,
    file: { filePath: '/fixture/local/README.md', relativePath: 'README.md', language: 'markdown' }
  },
  {
    ...on,
    type: 'openBrowserTab',
    tabId: 'tab-docs',
    browserTabId: 'browser-docs',
    pageId: 'page-docs',
    createdAt: 4,
    browserCreatedAt: 4
  },
  { ...on, type: 'createTerminalTab', tabId: 'tab-scratch', leafId: leaf(4), createdAt: 5 },
  { ...on, type: 'closeTabs', tabIds: ['tab-scratch'], force: true, recordClose: 'user' }
]

function windowSave(stored: WorkspaceSessionState): WorkspaceSessionState {
  const page = {
    id: 'page-docs',
    workspaceId: 'browser-docs',
    worktreeId: WORKTREE,
    url: 'https://example.com/docs',
    title: 'Docs',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 4
  }
  return {
    ...stored,
    activeRepoId: 'repo-local',
    activeWorktreeId: WORKTREE,
    activeTabId: 'tab-shell',
    browserPagesByWorkspace: { 'browser-docs': [page] },
    browserTabsByWorktree: {
      [WORKTREE]: (stored.browserTabsByWorktree?.[WORKTREE] ?? []).map((tab) => ({
        ...tab,
        url: page.url,
        title: page.title
      }))
    }
  }
}

async function apply(store: Store, command: LayoutCommand): Promise<void> {
  const result = await store.applyLayoutCommand(command)
  expect(result.ok, command.type).toBe(true)
}

/** The session main wrote to disk, as the profile database holds it. */
function writtenSession(directory: string): string {
  const authority = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  const serialized = authority.readSerializedState()
  authority.close()
  const profile: { workspaceSession: unknown } = JSON.parse(serialized ?? '{}')
  return `${JSON.stringify(profile.workspaceSession, null, 2)}\n`
}

// Proves the current switch-off code reads a switch-on save, not that older released builds do.
describe('the session a layout-owner build writes (downgrade probe, ledger L8)', () => {
  it('is the checked-in golden, byte for byte', async () => {
    expect(WORKTREE).toBe(FIXTURE_GIT_WORKTREE_ID)
    const directory = mkdtempSync(join(tmpdir(), 'orca-layout-owner-golden-'))
    directories.push(directory)
    const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 })
    minting.on = true

    for (const command of COMMANDS.slice(0, 4)) {
      await apply(store, command)
    }
    const shellGroup = store.getWorkspaceSession().tabGroups?.[WORKTREE]?.[0]?.id
    await apply(store, {
      ...on,
      type: 'splitGroup',
      tabId: 'tab-build',
      besideGroupId: shellGroup!,
      direction: 'right'
    })
    for (const command of COMMANDS.slice(4)) {
      await apply(store, command)
    }
    await store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: 'tab-shell',
      leafId: leaf(1),
      ptyId: 'pty-shell',
      incarnationId: 'inc-shell'
    })
    minting.on = false
    // The window's own save (session:set): its selection and the page its browser tab shows.
    const stored = store.getWorkspaceSession()
    store.setWorkspaceSession(windowViewSaveForMain(stored, windowSave(stored), undefined))
    await store.flushPendingOrThrowAsync()
    await store.freezeWritesAsync()

    const written = writtenSession(directory)
    // Times are pinned (fake Date) and minted ids numbered; no machine path may reach the golden.
    expect(written).not.toContain(tmpdir())
    if (process.env[UPDATE_ENV] === '1') {
      writeFileSync(LAYOUT_OWNER_WRITTEN_SESSION_GOLDEN_PATH, written)
    }
    const golden = JSON.parse(readFileSync(LAYOUT_OWNER_WRITTEN_SESSION_GOLDEN_PATH, 'utf8'))
    // Re-serialized so the formatter's line breaks do not count; key order and values do.
    expect(
      written,
      `the switch-on save format changed: regenerate with ${UPDATE_ENV}=1, then the switch-off ` +
        'restore tests (layout-owner-written-session-switch-off-load, ' +
        'layout-owner-written-session-hydration) must still pass: they are the downgrade proof'
    ).toBe(`${JSON.stringify(golden, null, 2)}\n`)
  })
})
