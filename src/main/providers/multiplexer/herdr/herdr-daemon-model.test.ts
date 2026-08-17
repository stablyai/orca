import { describe, expect, it } from 'vitest'
import { HerdrDaemonModel } from './herdr-daemon-model'
import {
  herdrExportLayout,
  herdrLayoutSnapshot,
  herdrSessionSnapshot
} from './herdr-daemon-snapshot'
import { HERDR_PROTOCOL_VERSION } from './herdr-daemon-schema'

function makeModel(): HerdrDaemonModel {
  const model = new HerdrDaemonModel('test-session')
  model.ensureWorkspace('my-project', { worktree: { checkout_path: '/repo' } })
  model.ensureTab('w1', 'default')
  model.createPane('w1', 't1', { cwd: '/repo' })
  return model
}

describe('HerdrDaemonModel', () => {
  it('ensures workspaces idempotently by label', () => {
    const model = makeModel()
    const again = model.ensureWorkspace('my-project')
    expect(again.workspace_id).toBe('w1')
    expect(model.listWorkspaces()).toHaveLength(1)
    expect(again.worktree).toEqual({ checkout_path: '/repo' })
  })

  it('ensures tabs idempotently per workspace', () => {
    const model = makeModel()
    const again = model.ensureTab('w1', 'default')
    expect(again.tab_id).toBe('t1')
    expect(model.listTabs()).toHaveLength(1)
  })

  it('creates a pane and snapshots a single-pane layout', () => {
    const model = makeModel()
    const layout = herdrLayoutSnapshot(model, 't1', { x: 0, y: 0, width: 120, height: 30 })
    expect(layout.panes).toEqual([{ pane_id: 'p1', rect: { x: 0, y: 0, width: 120, height: 30 } }])
    expect(layout.focused_pane_id).toBe('p1')
    expect(layout.area).toEqual({ x: 0, y: 0, width: 120, height: 30 })
  })

  it('splits a pane into a two-leaf tree with computed rects', () => {
    const model = makeModel()
    model.splitPane('p1', 'right', 0.25, { cwd: '/repo' })
    const layout = herdrLayoutSnapshot(model, 't1', { x: 0, y: 0, width: 120, height: 30 })
    expect(layout.panes).toHaveLength(2)
    expect(layout.panes[0]).toMatchObject({ pane_id: 'p1' })
    expect(layout.panes[0].rect.width).toBe(30)
    expect(layout.panes[1].rect.width).toBe(90)
    expect(layout.panes[1].rect.x).toBe(30)
    expect(layout.splits).toHaveLength(1)
    expect(layout.splits?.[0]).toMatchObject({ direction: 'right', ratio: 0.25 })
  })

  it('closes a pane, collapses the split, and re-focuses a survivor', () => {
    const model = makeModel()
    model.splitPane('p1', 'down', 0.5, { cwd: '/repo' })
    model.closePane('p2')
    const layout = herdrLayoutSnapshot(model, 't1')
    expect(layout.panes).toHaveLength(1)
    expect(layout.panes[0].pane_id).toBe('p1')
    expect(layout.focused_pane_id).toBe('p1')
  })

  it('closes the last pane and drops the empty tab', () => {
    const model = makeModel()
    model.closePane('p1')
    expect(model.getTab('t1')).toBeUndefined()
    expect(model.listPanes()).toHaveLength(0)
  })

  it('focusing a pane bumps its revision and moves focus', () => {
    const model = makeModel()
    model.splitPane('p1', 'right', 0.5, { cwd: '/repo' })
    model.focusPane('p1')
    expect(model.getPane('p1')?.revision).toBe(1)
    expect(herdrLayoutSnapshot(model, 't1').focused_pane_id).toBe('p1')
  })

  it('sets the split ratio on the split holding a pane', () => {
    const model = makeModel()
    model.splitPane('p1', 'right', 0.5, { cwd: '/repo' })
    model.setSplitRatio('p2', 0.8)
    expect(herdrLayoutSnapshot(model, 't1').splits?.[0].ratio).toBe(0.8)
  })

  it('exports the layout as a LayoutNode tree', () => {
    const model = makeModel()
    model.splitPane('p1', 'right', 0.5, { cwd: '/repo' })
    const root = herdrExportLayout(model, 't1')
    expect(root.type).toBe('split')
    expect(root.direction).toBe('right')
    expect(root.first).toMatchObject({ type: 'pane', pane_id: 'p1', cwd: '/repo' })
    expect(root.second).toMatchObject({ type: 'pane', pane_id: 'p2' })
  })

  it('serves a protocol-19 session snapshot with workspaces, tabs, panes and layouts', () => {
    const model = makeModel()
    model.splitPane('p1', 'down', 0.5, { cwd: '/repo' })
    const snapshot = herdrSessionSnapshot(model, HERDR_PROTOCOL_VERSION)
    expect(snapshot.protocol).toBe(HERDR_PROTOCOL_VERSION)
    expect(snapshot.version).toBeTruthy()
    expect(snapshot.workspaces).toEqual([
      { workspace_id: 'w1', label: 'my-project', worktree: { checkout_path: '/repo' } }
    ])
    expect(snapshot.tabs).toEqual([{ tab_id: 't1', workspace_id: 'w1', label: 'default' }])
    expect(snapshot.panes).toHaveLength(2)
    expect(snapshot.layouts).toHaveLength(1)
    expect(snapshot.layouts[0].panes).toHaveLength(2)
    expect(snapshot.agents).toEqual([])
  })

  it('applies a nested layout tree and mirrors it in export and snapshot', () => {
    const model = makeModel()
    const ids = model.applyLayout(
      'w1',
      't1',
      {
        type: 'split',
        direction: 'right',
        ratio: 0.5,
        first: { type: 'pane', pane_id: 'a', cwd: '/repo' },
        second: {
          type: 'split',
          direction: 'down',
          ratio: 0.5,
          first: { type: 'pane', pane_id: 'b', cwd: '/repo' },
          second: { type: 'pane', pane_id: 'c', cwd: '/repo' }
        }
      },
      '/repo'
    )
    expect(ids).toHaveLength(3)
    const root = herdrExportLayout(model, 't1')
    expect(root.type).toBe('split')
    expect(root.first).toMatchObject({ type: 'pane', cwd: '/repo' })
    expect(root.second).toMatchObject({ type: 'split', direction: 'down' })
    const layout = herdrLayoutSnapshot(model, 't1')
    expect(layout.panes).toHaveLength(3)
    expect(layout.panes[0].rect.width).toBe(60)
    expect(layout.panes[1].rect.height).toBe(15)
  })

  it('applying a layout replaces existing panes of the tab', () => {
    const model = makeModel()
    model.splitPane('p1', 'right', 0.5, { cwd: '/repo' })
    expect(model.listPanes()).toHaveLength(2)
    model.applyLayout('w1', 't1', { type: 'pane', pane_id: 'new', cwd: '/repo' }, '/repo')
    expect(model.listPanes()).toHaveLength(1)
    expect(herdrLayoutSnapshot(model, 't1').panes).toHaveLength(1)
  })

  it('setPaneTokens enforces single ownership per token key', () => {
    const model = makeModel()
    model.splitPane('p1', 'right', 0.5, { cwd: '/repo' })
    model.setPaneTokens('p1', { orca_binding: 'leaf-a' })
    expect(model.getPane('p1')?.tokens?.orca_binding).toBe('leaf-a')

    const p2 = model.listPanes().find((pane) => pane.pane_id !== 'p1')!
    model.setPaneTokens(p2.pane_id, { orca_binding: 'leaf-a' })
    expect(model.getPane(p2.pane_id)?.tokens?.orca_binding).toBe('leaf-a')
    expect(model.getPane('p1')?.tokens?.orca_binding).toBeUndefined()

    // Unrelated keys are untouched by the ownership sweep.
    model.setPaneTokens('p1', { other_key: 'kept' })
    model.setPaneTokens(p2.pane_id, { orca_binding: 'leaf-b' })
    expect(model.getPane('p1')?.tokens?.other_key).toBe('kept')
  })
})
