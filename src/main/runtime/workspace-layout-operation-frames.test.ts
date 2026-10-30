// Check each operation's single records frame against a fresh real-Store projection, with or without a window (E1).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { GeneratedTabTitle } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutStreamEvent } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import type { Store } from '../persistence/loading-store/store'
import { WindowSession } from '../persistence/terminal-topology/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID as FOLDER,
  FIXTURE_GIT_WORKTREE_ID as GIT,
  openTopologyStore
} from '../persistence/terminal-topology/terminal-topology-profile-fixture'
import { applyWindowLayoutCommand } from './runtime-layout-apply'
import {
  layoutFrameModelErrors,
  logLayoutFrameModelErrors
} from './workspace-layout-frame-model-check'
import { installLayoutFrameModelCheck } from './workspace-layout-frame-model-check.test-fixture'
import {
  observeWorkspaceLayoutFrames,
  type LayoutFrameObservation
} from './workspace-layout-frame-observer'
import { WorkspaceLayoutStream, type LayoutOperationCommit } from './workspace-layout-stream'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
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
  const SPREAD = { [GIT]: 50, [FOLDER]: 49, [SSH_KEY]: 1 }

  it('publishes 100 generated titles in three workspaces and two partitions as one frame', async () => {
    const store = await storeWith(SPREAD)
    const frames: WorkspaceLayoutStreamEvent[] = []
    const { seq } = streamOver(store).subscribe((frame) => frames.push(frame))

    await expect(renameTabs(store, titles(SPREAD))).resolves.toEqual({ ok: true, result: {} })

    expect(frames).toHaveLength(1)
    const frame = frames[0]
    if (frame?.type !== 'records') {
      throw new Error('expected one records frame')
    }
    expect(frame.seq).toBe(seq + 1)
    expect(
      frame.workspaces.map(({ key, change, ...records }) => [key, change, Object.keys(records)])
    ).toEqual([
      [GIT, 'records', ['tabs']],
      [FOLDER, 'records', ['tabs']],
      [SSH_KEY, 'records', ['tabs']]
    ])
    expect(
      frame.workspaces.flatMap((change) => ('tabs' in change ? change.tabs!.set! : []))
    ).toHaveLength(100)
    expect(check.failures).toEqual([])
    expect(check.checked()).toBe(1)
  })

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

  it('sends nothing for an operation that changes no record', async () => {
    const store = await storeWith({ [GIT]: 1 })
    const frames: WorkspaceLayoutStreamEvent[] = []
    streamOver(store).subscribe((frame) => frames.push(frame))

    await renameTabs(store, [{ workspace: GIT, tabId: 'missing', title: 'Gone' }])

    expect(frames).toEqual([])
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

describe("main's model check on every frame", () => {
  it('passes the frame main sent and catches a broken copy of it', async () => {
    check.uninstall()
    const store = await storeWith({ [GIT]: 3 })
    const observed: LayoutFrameObservation[] = []
    observeWorkspaceLayoutFrames((observation) => observed.push(observation))
    streamOver(store).subscribe(() => {})

    await renameTabs(store, titles({ [GIT]: 3 }))

    expect(observed).toHaveLength(1)
    const observation = observed[0]!
    expect(layoutFrameModelErrors(observation)).toEqual([])
    const broken = structuredClone(observation.frame)
    const change = broken.workspaces[0]!
    if (change.change !== 'records') {
      throw new Error('expected a records change')
    }
    change.tabs!.set!.pop()
    expect(layoutFrameModelErrors({ ...observation, frame: broken })).toEqual([
      `frame ${broken.seq}: ${GIT} differs from a fresh projection`
    ])
    observeWorkspaceLayoutFrames(null)
  })
})

describe("the dev build's model check", () => {
  it('skips a frame that only changed live titles, and checks a structural one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fresh = vi.fn(() => new Map())
    const frame = {
      type: 'records' as const,
      epoch: 'epoch-1',
      seq: 1,
      workspaces: [{ key: GIT, change: 'removed' as const }]
    }
    logLayoutFrameModelErrors({ frame, before: new Map(), fresh, titlesOnly: true })
    expect(fresh).not.toHaveBeenCalled()
    logLayoutFrameModelErrors({ frame, before: new Map(), fresh, titlesOnly: false })
    expect(fresh).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('a headless main', () => {
  it('hears each operation with no layout subscriber, from one projection it shares', async () => {
    const store = await storeWith({ [GIT]: 2, [SSH_KEY]: 1 })
    const getSession = vi.spyOn(store, 'getWorkspaceSession')
    const stream = streamOver(store)
    const commits: LayoutOperationCommit[] = []
    stream.onLayoutOperationCommitted((commit) => commits.push(commit))
    const first = stream.readPartition('local')

    await renameTabs(store, titles({ [SSH_KEY]: 1 }))

    expect(commits).toEqual([{ hostIds: [SSH] }])
    getSession.mockClear()
    expect(stream.readPartition('local')).toBe(first)
    expect(getSession).not.toHaveBeenCalled()
    const ssh = stream.readPartition(SSH)!.layout.workspaces[SSH_KEY]!
    expect(ssh.tabs.map((tab) => tab.generatedTitle)).toEqual(['Title 0'])
    // Readers share the stream's model; mutations must fail.
    expect(() => {
      ssh.tabs[0]!.generatedTitle = 'edited'
    }).toThrow(TypeError)
    await renameTabs(store, [{ workspace: GIT, tabId: tabIdOf(GIT, 0), title: 'Next' }])
    expect(stream.readPartition('local')!.layout.workspaces[GIT]!.tabs[0]!.generatedTitle).toBe(
      'Next'
    )
  })

  it('sends a window-style and a phone-style subscriber the same frames', async () => {
    const store = await storeWith({ [GIT]: 2, [FOLDER]: 1 })
    const stream = streamOver(store)
    const window: WorkspaceLayoutStreamEvent[] = []
    const phone: WorkspaceLayoutStreamEvent[] = []
    const windowSub = stream.subscribe((frame) => window.push(frame))
    const phoneSub = stream.subscribe((frame) => phone.push(frame))

    await renameTabs(store, titles({ [GIT]: 2, [FOLDER]: 1 }))
    await store.persistPtyBinding({
      worktreeId: GIT,
      tabId: tabIdOf(GIT, 0),
      leafId: leafOf(0),
      ptyId: 'pty-0'
    })

    expect(window).toHaveLength(2)
    expect(phone).toEqual(window)
    expect(phoneSub.snapshot).toEqual(windowSub.snapshot)
    expect(check.failures).toEqual([])
    expect(check.checked()).toBe(2)
  })
})
