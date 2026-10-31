import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { TERMINAL_QUERY_METHODS } from '../../rpc/methods/terminal/terminal-query-methods'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))

// A window sweep must let main place only that workspace's unshown live terminals before listing them.

const SWEPT = FIXTURE_GIT_WORKTREE_ID
const OTHER = 'repo-local::/fixture/other'
const directories: string[] = []

type LiveSession = {
  id: string
  cwd: string
  title: string
  worktreeId: string
  incarnationId?: string
  exiting?: true
}

class SweepRuntime extends OrcaRuntimeService {
  protected override async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map(
      [SWEPT, OTHER].flatMap((id) => {
        const worktree = this.buildResolvedWorktreeFromId(id)
        return worktree ? [[id, worktree] as const] : []
      })
    )
  }

  ptyRecord(ptyId: string) {
    return this.ptysById.get(ptyId)
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function session(id: string, worktreeId = SWEPT): LiveSession {
  return { id, cwd: '/fixture/local', title: 'zsh', worktreeId, incarnationId: `${id}-inc` }
}

function runtimeOn(store: Store, live: LiveSession[]): SweepRuntime {
  const runtime = new SweepRuntime(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [...live],
    listProcessesWithHostScope: async () => ({ processes: [...live], hostIds: ['local' as const] })
  })
  return runtime
}

async function hostWith(live: LiveSession[]) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sweep-placement-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  return { store, directory, runtime: runtimeOn(store, live) }
}

function boundPtyIds(store: Store, worktreeId: string): string[] {
  const session = store.getWorkspaceSession()
  return (session.tabsByWorktree[worktreeId] ?? []).flatMap((tab) =>
    Object.values(session.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
  )
}

function terminalListHandler() {
  const method = TERMINAL_QUERY_METHODS.find((candidate) => candidate.name === 'terminal.list')
  if (!method) {
    throw new Error('terminal.list is not defined')
  }
  return method.handler
}

describe('main places the swept workspace’s live terminals, layout-owner build', () => {
  it('shows the swept workspace’s unshown terminal in a tab, and leaves another workspace’s', async () => {
    const { store, runtime } = await hostWith([session('pty-swept'), session('pty-other', OTHER)])

    await runtime.placeUnshownLiveTerminalsOf(`id:${SWEPT}`)

    expect(boundPtyIds(store, SWEPT)).toEqual(['pty-swept'])
    expect(boundPtyIds(store, OTHER)).toEqual([])
  })

  it('the sweep’s listing places before it lists, so it names the placed terminal’s pane', async () => {
    const { runtime } = await hostWith([session('pty-swept')])

    const context = { runtime }
    const listing = await terminalListHandler()(
      {
        worktree: `id:${SWEPT}`,
        limit: 200,
        requireFreshPtyLiveness: true,
        includeVisualLayouts: false,
        placeUnshownLiveTerminals: true
      },
      context
    )

    const listed = listing.terminals.find((terminal) => terminal.ptyId === 'pty-swept')
    expect(listed).toMatchObject({ orphaned: false })
    expect(listed?.tabId).not.toMatch(/^pty:/)
  })

  it('a listing that does not ask places nothing', async () => {
    const { store, runtime } = await hostWith([session('pty-swept')])

    const context = { runtime }
    await terminalListHandler()(
      { worktree: `id:${SWEPT}`, limit: 200, requireFreshPtyLiveness: true },
      context
    )

    expect(boundPtyIds(store, SWEPT)).toEqual([])
  })

  it('leaves a terminal whose registration is still binding its pane, as a census does', async () => {
    const { store, runtime } = await hostWith([session('pty-registering')])
    runtime.beginPtyRegistration('pty-registering', 'pty-registering-inc')

    await runtime.placeUnshownLiveTerminals()

    expect(boundPtyIds(store, SWEPT)).toEqual([])
  })

  it('never brings back a closed tab’s terminal its host is killing', async () => {
    const { store, runtime } = await hostWith([{ ...session('pty-closing'), exiting: true }])

    await runtime.placeUnshownLiveTerminals()

    expect(boundPtyIds(store, SWEPT)).toEqual([])
  })
})

describe('a terminal created by the CLI, across a restart, layout-owner build', () => {
  it('is left alone while its run owns it, and after a restart is shown like any other', async () => {
    const live = [session('pty-cli')]
    const { store, directory, runtime } = await hostWith(live)
    // The census records it; the CLI's create marks it owned by this run (terminal-create.ts).
    await runtime.listTerminals(`id:${SWEPT}`)
    runtime.ptyRecord('pty-cli')!.runtimeSessionOwned = true

    await runtime.placeUnshownLiveTerminals()
    expect(boundPtyIds(store, SWEPT)).toEqual([])

    // Run ownership is not saved; after restart, main must place the surviving unshown terminal as the window-owned sweep would.
    const relaunched = await reopenTopologyStore(store, directory)
    const restarted = runtimeOn(relaunched, live)
    await restarted.placeUnshownLiveTerminals()

    expect(restarted.ptyRecord('pty-cli')?.runtimeSessionOwned).toBe(false)
    expect(boundPtyIds(relaunched, SWEPT)).toEqual(['pty-cli'])
  })

  it('one whose pane was saved stays in that pane after a restart, with no second tab', async () => {
    const live = [session('pty-cli')]
    const { store, directory, runtime } = await hostWith(live)
    await runtime.placeUnshownLiveTerminals()
    expect(boundPtyIds(store, SWEPT)).toEqual(['pty-cli'])

    const relaunched = await reopenTopologyStore(store, directory)
    await runtimeOn(relaunched, live).placeUnshownLiveTerminals()

    expect(boundPtyIds(relaunched, SWEPT)).toEqual(['pty-cli'])
  })
})
