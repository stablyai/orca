import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { OrcaRuntimeService } from '../../orca-runtime'
import { FIRST_SURFACE_PLACEMENT_WAIT_MS } from './restored-terminal-placement'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))

// A live terminal main has not placed yet, with no sleeping record: the window's activation
// finds no tab and asks main for the workspace's first one while main's placement is still
// reading the host census. The workspace must end with the live terminal's tab only.

const WT = FIXTURE_GIT_WORKTREE_ID
const LIVE_PTY = `${WT}@@live`
const WINDOW_TAB = '33333333-3333-4333-8333-333333333333'
const WINDOW_LEAF = '44444444-4444-4444-8444-444444444444'
const directories: string[] = []

class CensusRuntime extends OrcaRuntimeService {
  protected override async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    const worktree = this.buildResolvedWorktreeFromId(WT)
    return new Map(worktree ? [[WT, worktree]] : [])
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function hostPlacingALiveTerminal() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-placement-before-initial-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const live = [{ id: LIVE_PTY, cwd: '/fixture/local', title: 'zsh', worktreeId: WT }]
  let answerCensus = (): void => {}
  const census = new Promise<typeof live>((resolve) => {
    answerCensus = () => resolve(live)
  })
  const listProcesses = vi.fn(() => census)
  const spawn = vi.fn()
  const runtime = new CensusRuntime(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses
  })
  const placing = runtime.placeUnshownLiveTerminals()
  await vi.waitFor(() => expect(listProcesses).toHaveBeenCalled())
  const activate = () =>
    runtime.applyLayoutCommand({
      type: 'createTerminalTab',
      workspace: WT,
      tabId: WINDOW_TAB,
      leafId: WINDOW_LEAF,
      initial: 'activation'
    })
  const tabsOf = () => store.getWorkspaceSession().tabsByWorktree[WT] ?? []
  return { store, spawn, placing, answerCensus, activate, tabsOf }
}

it("gives an activating workspace no fresh shell beside a live terminal main's placement is still placing", async () => {
  const { store, spawn, placing, answerCensus, activate, tabsOf } = await hostPlacingALiveTerminal()

  const activation = activate()
  answerCensus()
  await placing
  const reply = await activation

  const tabs = tabsOf()
  expect(tabs).toHaveLength(1)
  expect(
    Object.values(
      store.getWorkspaceSession().terminalLayoutsByTabId[tabs[0]!.id]?.ptyIdsByLeafId ?? {}
    )
  ).toEqual([LIVE_PTY])
  expect(reply.ok && reply.result.tabId).toBeFalsy()
  expect(spawn).not.toHaveBeenCalled()
})

it('admits the first tab once the cap passes while the placement pass is still reading the census', async () => {
  const { placing, answerCensus, activate, tabsOf } = await hostPlacingALiveTerminal()

  const startedAt = performance.now()
  const reply = await activate()
  const waitedMs = performance.now() - startedAt

  expect(waitedMs).toBeGreaterThanOrEqual(FIRST_SURFACE_PLACEMENT_WAIT_MS - 20)
  expect(waitedMs).toBeLessThan(FIRST_SURFACE_PLACEMENT_WAIT_MS + 1_000)
  expect(reply.ok && reply.result.tabId).toBe(WINDOW_TAB)
  expect(tabsOf().map((tab) => tab.id)).toEqual([WINDOW_TAB])
  answerCensus()
  await placing
})
