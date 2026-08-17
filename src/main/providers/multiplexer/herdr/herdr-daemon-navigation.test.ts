import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

// Why: protocol-19 navigation, reorder, and worktree surface served by the
// daemon. These are all model-driven: no PTY is required beyond layout.apply's
// pane spawn, which the earlier pane lifecycle tests already exercise.
describe('herdr daemon protocol-19 navigation + worktree surface', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setup(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-nav-test-'))
    socketPath = join(dir, 'herdr.sock')
    process.env.HOME = dir
    setHerdrTestDataDir(dir)
    server = new HerdrTransport(socketPath)
    daemon = new HerdrDaemon(server)
    await server.startServer()
  }

  async function roundTrip<T>(method: string, params: unknown): Promise<T> {
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      return (await client.request(method, params)) as T
    } finally {
      await client.close()
    }
  }

  async function makeWorkspace(label: string): Promise<{ workspace_id: string; tab_id: string }> {
    const created = await roundTrip<{
      workspace: { workspace_id: string }
      tab: { tab_id: string }
    }>('workspace.create', {
      label
    })
    return { workspace_id: created.workspace.workspace_id, tab_id: created.tab.tab_id }
  }

  async function makeLayout(
    workspaceId: string,
    root: unknown
  ): Promise<{
    layout: {
      panes: { pane_id: string }[]
      splits: { id: string }[]
      focused_pane_id?: string
    }
  }> {
    return roundTrip('layout.apply', {
      root,
      workspace_id: workspaceId,
      tab_label: 'default'
    })
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
  })

  it('answers pane.neighbor in each direction', async () => {
    await setup()
    const ws = await makeWorkspace('proj')
    const applied = await makeLayout(ws.workspace_id, {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'a' },
      second: { type: 'pane', pane_id: 'b' }
    })
    const [left, right] = applied.layout.panes.map((p) => p.pane_id)

    const toRight = await roundTrip<{ neighbor_pane_id: string | null; direction: string }>(
      'pane.neighbor',
      { direction: 'right', pane_id: left }
    )
    expect(toRight.neighbor_pane_id).toBe(right)

    const toLeft = await roundTrip<{ neighbor_pane_id: string | null; direction: string }>(
      'pane.neighbor',
      { direction: 'left', pane_id: right }
    )
    expect(toLeft.neighbor_pane_id).toBe(left)

    const pastEdge = await roundTrip<{ neighbor_pane_id: string | null }>('pane.neighbor', {
      direction: 'left',
      pane_id: left
    })
    expect(pastEdge.neighbor_pane_id).toBeNull()
  })

  it('reports pane.edges for boundary and interior panes', async () => {
    await setup()
    const ws = await makeWorkspace('proj')
    const applied = await makeLayout(ws.workspace_id, {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'a' },
      second: { type: 'pane', pane_id: 'b' }
    })
    const [left, right] = applied.layout.panes.map((p) => p.pane_id)

    const leftEdges = await roundTrip<{
      left: boolean
      right: boolean
      up: boolean
      down: boolean
    }>('pane.edges', { pane_id: left })
    expect(leftEdges.left).toBe(true)
    expect(leftEdges.right).toBe(false)

    const rightEdges = await roundTrip<{ left: boolean; right: boolean }>('pane.edges', {
      pane_id: right
    })
    expect(rightEdges.right).toBe(true)
    expect(rightEdges.left).toBe(false)
  })

  it('swaps two panes in the layout', async () => {
    await setup()
    const ws = await makeWorkspace('proj')
    const applied = await makeLayout(ws.workspace_id, {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'a' },
      second: { type: 'pane', pane_id: 'b' }
    })
    const [left, right] = applied.layout.panes.map((p) => p.pane_id)

    const swapped = await roundTrip<{
      changed: boolean
      source_pane_id: string
      target_pane_id: string
      layout: { panes: { pane_id: string }[] }
    }>('pane.swap', { source_pane_id: left, target_pane_id: right })
    expect(swapped.changed).toBe(true)
    expect(swapped.source_pane_id).toBe(left)
    expect(swapped.target_pane_id).toBe(right)

    const byDirection = await roundTrip<{ target_pane_id: string | null }>('pane.swap', {
      pane_id: right,
      direction: 'right'
    })
    expect(byDirection.target_pane_id).toBe(left)
  })

  it('focuses the neighbor via pane.focus_direction', async () => {
    await setup()
    const ws = await makeWorkspace('proj')
    const applied = await makeLayout(ws.workspace_id, {
      type: 'split',
      direction: 'down',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'a' },
      second: { type: 'pane', pane_id: 'b' }
    })
    const [top, bottom] = applied.layout.panes.map((p) => p.pane_id)

    const result = await roundTrip<{
      changed: boolean
      focused_pane_id: string
      pane_id: string | null
    }>('pane.focus_direction', { direction: 'down', pane_id: top })
    expect(result.changed).toBe(true)
    expect(result.focused_pane_id).toBe(bottom)

    const noop = await roundTrip<{ changed: boolean; pane_id: string | null }>(
      'pane.focus_direction',
      { direction: 'up', pane_id: top }
    )
    expect(noop.changed).toBe(false)
    expect(noop.pane_id).toBeNull()
  })

  it('reorders workspaces with workspace.move and workspace.move_block', async () => {
    await setup()
    const a = await makeWorkspace('a')
    const b = await makeWorkspace('b')
    const c = await makeWorkspace('c')

    await roundTrip('workspace.move', { workspace_id: c.workspace_id, insert_index: 0 })
    let list = await roundTrip<{ workspaces: { workspace_id: string }[] }>('workspace.list', {})
    expect(list.workspaces.map((w) => w.workspace_id)).toEqual([
      c.workspace_id,
      a.workspace_id,
      b.workspace_id
    ])

    await roundTrip('workspace.move_block', {
      workspace_ids: [a.workspace_id, c.workspace_id],
      before_workspace_id: b.workspace_id
    })
    list = await roundTrip<{ workspaces: { workspace_id: string }[] }>('workspace.list', {})
    expect(list.workspaces.map((w) => w.workspace_id)).toEqual([
      a.workspace_id,
      c.workspace_id,
      b.workspace_id
    ])
  })

  it('reorders tabs with tab.move and closes them with tab.close', async () => {
    await setup()
    const ws = await makeWorkspace('proj')
    const t1 = await roundTrip<{ tab: { tab_id: string } }>('tab.create', {
      workspace_id: ws.workspace_id,
      label: 'one'
    })
    const t2 = await roundTrip<{ tab: { tab_id: string } }>('tab.create', {
      workspace_id: ws.workspace_id,
      label: 'two'
    })

    await roundTrip('tab.move', { tab_id: t2.tab.tab_id, insert_index: 0 })
    let tabs = await roundTrip<{ tabs: { tab_id: string }[] }>('tab.list', {})
    expect(tabs.tabs.map((t) => t.tab_id)).toEqual([t2.tab.tab_id, ws.tab_id, t1.tab.tab_id])

    await roundTrip('tab.close', { tab_id: t1.tab.tab_id })
    tabs = await roundTrip<{ tabs: { tab_id: string }[] }>('tab.list', {})
    expect(tabs.tabs.map((t) => t.tab_id)).toEqual([t2.tab.tab_id, ws.tab_id])
  })

  it('records workspace metadata from workspace.report_metadata', async () => {
    await setup()
    const ws = await makeWorkspace('proj')
    await roundTrip('workspace.report_metadata', {
      workspace_id: ws.workspace_id,
      source: 'cli',
      tokens: { project: 'orca' }
    })
    const got = await roundTrip<{ workspace_id: string; tokens: Record<string, string> }>(
      'workspace.get',
      { workspace_id: ws.workspace_id }
    )
    expect(got.tokens).toEqual({ project: 'orca' })
  })

  it('opens, lists, and removes worktrees', async () => {
    await setup()
    const opened = await roundTrip<{ workspace: { workspace_id: string; label: string } }>(
      'worktree.open',
      {
        path: '/src/orca',
        branch: 'feat/herdr'
      }
    )
    expect(opened.workspace.label).toBe('orca')

    const listed = await roundTrip<{
      worktrees: {
        workspace_id: string
        label: string
        worktree: { checkout_path: string; is_linked_worktree: boolean }
      }[]
    }>('worktree.list', {})
    expect(listed.worktrees).toHaveLength(1)
    expect(listed.worktrees[0].worktree.checkout_path).toBe('/src/orca')
    expect(listed.worktrees[0].worktree.is_linked_worktree).toBe(true)

    await roundTrip('worktree.remove', { workspace_id: opened.workspace.workspace_id })
    const after = await roundTrip<{ worktrees: unknown[] }>('worktree.list', {})
    expect(after.worktrees).toHaveLength(0)
  })

  it('rejects worktree.open without a path', async () => {
    await setup()
    await expect(roundTrip('worktree.open', {})).rejects.toMatchObject({
      code: 'invalid_params'
    })
  })

  it('moves a pane to a new tab and a new workspace', async () => {
    await setup()
    const ws = await makeWorkspace('proj')
    const applied = await makeLayout(ws.workspace_id, {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'a' },
      second: { type: 'pane', pane_id: 'b' }
    })
    const [paneA, paneB] = applied.layout.panes.map((p) => p.pane_id)

    const toNewTab = await roundTrip<{
      changed: boolean
      pane_id: string
      previous_tab_id: string
      created_tab: { tab_id: string; workspace_id: string; label: string } | null
    }>('pane.move', {
      pane_id: paneA,
      destination: { type: 'new_tab', workspace_id: ws.workspace_id, label: 'moved' }
    })
    expect(toNewTab.changed).toBe(true)
    expect(toNewTab.created_tab?.label).toBe('moved')

    const toNewWorkspace = await roundTrip<{
      created_workspace: { workspace_id: string; label: string } | null
    }>('pane.move', {
      pane_id: paneB,
      destination: { type: 'new_workspace', label: 'other', tab_label: 'main' }
    })
    expect(toNewWorkspace.created_workspace?.label).toBe('other')
  })

  it('moves a pane as a split into an existing tab', async () => {
    await setup()
    const ws = await makeWorkspace('proj')
    const applied = await makeLayout(ws.workspace_id, {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'a' },
      second: { type: 'pane', pane_id: 'b' }
    })
    const [paneA, paneB] = applied.layout.panes.map((p) => p.pane_id)

    const result = await roundTrip<{
      changed: boolean
      previous_tab_id: string
      closed_tab_id: string | null
    }>('pane.move', {
      pane_id: paneB,
      destination: {
        type: 'tab',
        target_pane_id: paneA,
        split: 'down'
      }
    })
    expect(result.changed).toBe(true)
    expect(result.previous_tab_id).toBeTruthy()
  })
})
