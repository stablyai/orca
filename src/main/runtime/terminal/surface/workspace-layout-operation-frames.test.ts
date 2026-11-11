// Check each operation's single records frame against a fresh real-Store projection, with or without a window (E1).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GeneratedTabTitle } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutStreamEvent } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { Store } from '../../../persistence/loading-store/store'
import { WindowSession } from '../../../persistence/terminal-topology/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID as GIT,
  openTopologyStore
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { applyWindowLayoutCommand } from '../layout/runtime-layout-apply'
import { installLayoutFrameModelCheck } from './workspace-layout-frame-model-check.test-fixture'
import { WorkspaceLayoutStream } from './workspace-layout-stream'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const SSH: ExecutionHostId = 'ssh:target-1'
const SSH_KEY = 'repo-ssh::/srv/api'
const homeOf = (key: string): ExecutionHostId => (key === SSH_KEY ? SSH : 'local')
const leafOf = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const directories: string[] = []

/** Tabs `tab-<workspace>-<n>` in each workspace, its panes unbound until a test binds one. */
async function storeWith(tabs: Record<string, number>): Promise<Store> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-operation-frames-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const sessions = new Map<ExecutionHostId, WindowSession>()
  let leaf = 0
  for (const [workspace, count] of Object.entries(tabs)) {
    const hostId = homeOf(workspace)
    const session = sessions.get(hostId) ?? new WindowSession(getDefaultWorkspaceSession())
    sessions.set(hostId, session)
    for (let index = 0; index < count; index += 1) {
      session.addTab(workspace, tabIdOf(workspace, index), leafOf(leaf++))
    }
  }
  for (const [hostId, session] of sessions) {
    store.setWorkspaceSession(session.snapshot(), hostId)
  }
  await store.flushPendingOrThrowAsync()
  return store
}

const tabIdOf = (workspace: string, index: number) =>
  `tab-${workspace.replace(/\W/g, '-')}-${index}`

function streamOver(store: Store): WorkspaceLayoutStream {
  return new WorkspaceLayoutStream({
    store: () => store,
    homeHostId: homeOf,
    liveTitle: () => null
  })
}

function titles(tabs: Record<string, number>): GeneratedTabTitle[] {
  return Object.entries(tabs).flatMap(([workspace, count]) =>
    Array.from({ length: count }, (_, index) => ({
      workspace,
      tabId: tabIdOf(workspace, index),
      title: `Title ${index}`
    }))
  )
}

const renameTabs = (store: Store, renames: GeneratedTabTitle[]) =>
  applyWindowLayoutCommand(store, (workspace) => [homeOf(workspace)], {
    type: 'renameTabs',
    kind: 'generated',
    renames
  })

let check: ReturnType<typeof installLayoutFrameModelCheck>

beforeEach(() => {
  check = installLayoutFrameModelCheck()
})

afterEach(() => {
  check.uninstall()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('one records frame per main operation', () => {
  it('publishes a pane bind as one binding record, and a same-id respawn as one more', async () => {
    const store = await storeWith({ [GIT]: 2 })
    const frames: WorkspaceLayoutStreamEvent[] = []
    streamOver(store).subscribe((frame) => frames.push(frame))
    const bind = (incarnationId: string) =>
      store.persistPtyBinding({
        worktreeId: GIT,
        tabId: tabIdOf(GIT, 1),
        leafId: leafOf(1),
        ptyId: 'pty-1',
        incarnationId
      })

    await bind('inc-1')
    await bind('inc-2')

    const binding = (ptyGeneration: number) => [
      {
        key: GIT,
        change: 'records',
        bindings: { set: [{ leafId: leafOf(1), ptyId: 'pty-1', ptyGeneration }] }
      }
    ]
    expect(frames.map((frame) => frame.type === 'records' && frame.workspaces)).toEqual([
      binding(1),
      binding(2)
    ])
    expect(check.failures).toEqual([])
  })
})

describe('a throwing operation listener', () => {
  it('fails neither the committed operation nor the listeners after it', async () => {
    const store = await storeWith({ [GIT]: 1 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const heard: (readonly string[] | null)[] = []
    store.onWorkspaceSessionOperationEnded(() => {
      throw new Error('listener failed')
    })
    store.onWorkspaceSessionOperationEnded((hostIds) => heard.push(hostIds))

    await expect(renameTabs(store, titles({ [GIT]: 1 }))).resolves.toEqual({ ok: true, result: {} })

    expect(heard).toEqual([['local']])
    expect(store.getWorkspaceSession().tabsByWorktree[GIT]![0]!.generatedTitle).toBe('Title 0')
    warn.mockRestore()
  })
})
