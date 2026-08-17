import { describe, expect, it, vi } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { HerdrHostTransport, HerdrSessionSnapshot } from './herdr-runtime-contract'
import { terminalLayoutToHerdrLayout, applyTabLayout } from './herdr-tab-layout'
import { ORCA_BINDING_TOKEN, orcaPaneBinding } from './herdr-binding-metadata'

const PROJECT = 'proj'
const WORKSPACE = 'w1'
const SESSION = 'orca-proj'

function makeTransport(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const requestMock = vi.fn(
    async (_session: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) {
        throw new Error(`unhandled method ${method}`)
      }
      return { id: 'r', result: handler(params) }
    }
  )
  const transport: HerdrHostTransport = {
    ensureSession: async () => undefined,
    request: async <T>(session: string, method: string, params: unknown) =>
      (await requestMock(session, method, params as Record<string, unknown>)) as {
        id: string
        result: T
      }
  }
  return { transport, calls }
}

function makeSnapshot(): HerdrSessionSnapshot {
  return { workspaces: [], tabs: [], panes: [] } as unknown as HerdrSessionSnapshot
}

describe('terminalLayoutToHerdrLayout', () => {
  it('converts a leaf to a bare pane', () => {
    expect(terminalLayoutToHerdrLayout({ type: 'leaf', leafId: 'l1' })).toEqual({ type: 'pane' })
  })

  it('converts splits recursively, mapping vertical to right and preserving ratio', () => {
    const root: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.25,
      first: { type: 'leaf', leafId: 'l1' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'l2' },
        second: { type: 'leaf', leafId: 'l3' }
      }
    }
    expect(terminalLayoutToHerdrLayout(root)).toEqual({
      type: 'split',
      direction: 'right',
      ratio: 0.25,
      first: { type: 'pane' },
      second: {
        type: 'split',
        direction: 'down',
        ratio: 0.5,
        first: { type: 'pane' },
        second: { type: 'pane' }
      }
    })
  })
})

describe('applyTabLayout', () => {
  const root: TerminalPaneLayoutNode = {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: 'l1' },
    second: { type: 'leaf', leafId: 'l2' }
  }
  const tab = { title: 'T', customTitle: null, startupCwd: '/x' }

  it('applies the layout, binds leaves in order, and updates the snapshot', async () => {
    const { transport, calls } = makeTransport({
      'layout.apply': () => ({
        layout: {
          tab_id: 't9',
          workspace_id: WORKSPACE,
          root: {
            type: 'split',
            direction: 'right',
            ratio: 0.5,
            first: { type: 'pane', pane_id: 'w1:p1' },
            second: { type: 'pane', pane_id: 'w1:p2' }
          }
        }
      }),
      'pane.report_metadata': () => ({ ok: true })
    })
    const snapshot = makeSnapshot()
    const bindings = await applyTabLayout(
      transport,
      SESSION,
      PROJECT,
      WORKSPACE,
      tab,
      root,
      snapshot
    )

    expect(bindings).toEqual(
      new Map([
        ['l1', 'w1:p1'],
        ['l2', 'w1:p2']
      ])
    )
    const applyCall = calls.find((call) => call.method === 'layout.apply')
    expect(applyCall?.params.workspace_id).toBe(WORKSPACE)
    expect(applyCall?.params.tab_label).toBe('T')
    expect(applyCall?.params.focus).toBe(false)
    expect(snapshot.panes.map((pane) => pane.pane_id)).toEqual(['w1:p1', 'w1:p2'])
    expect(snapshot.panes[0].tokens?.[ORCA_BINDING_TOKEN]).toBe(orcaPaneBinding(PROJECT, 'l1'))
    expect(snapshot.panes[1].tokens?.[ORCA_BINDING_TOKEN]).toBe(orcaPaneBinding(PROJECT, 'l2'))
  })

  it('prefers customTitle over title for tab_label', async () => {
    const { transport, calls } = makeTransport({
      'layout.apply': () => ({
        layout: { root: { type: 'pane', pane_id: 'w1:p1' }, tab_id: 't1' }
      }),
      'pane.report_metadata': () => ({ ok: true })
    })
    await applyTabLayout(
      transport,
      SESSION,
      PROJECT,
      WORKSPACE,
      { title: 'T', customTitle: 'Custom', startupCwd: '/x' },
      { type: 'leaf', leafId: 'l1' },
      makeSnapshot()
    )
    expect(calls.find((call) => call.method === 'layout.apply')?.params.tab_label).toBe('Custom')
  })

  it('returns null when layout.apply fails so the caller falls back to pane.split', async () => {
    const { transport } = makeTransport({})
    const result = await applyTabLayout(
      transport,
      SESSION,
      PROJECT,
      WORKSPACE,
      tab,
      root,
      makeSnapshot()
    )
    expect(result).toBeNull()
  })

  it('returns null when the applied tree does not match the leaf count', async () => {
    const { transport } = makeTransport({
      'layout.apply': () => ({ layout: { root: { type: 'pane', pane_id: 'w1:p1' }, tab_id: 't1' } })
    })
    const result = await applyTabLayout(
      transport,
      SESSION,
      PROJECT,
      WORKSPACE,
      tab,
      root,
      makeSnapshot()
    )
    expect(result).toBeNull()
  })
})
