import { describe, expect, it, vi } from 'vitest'
import { SessionTabsRegistry } from './session-tabs-registry'

type PaneStub = {
  tabId: string | null
  editState: 'none' | 'clean' | 'dirty' | 'conflict'
  setTab: ReturnType<typeof vi.fn>
  focusInput: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

function paneStub(over: Partial<PaneStub> = {}): PaneStub {
  return {
    tabId: null,
    editState: 'none',
    setTab: vi.fn(),
    focusInput: vi.fn(),
    refresh: vi.fn(),
    ...over
  }
}

const snapshot = {
  snapshots: [
    {
      worktree: 'wt-1',
      tabs: [
        { type: 'terminal', id: 't1', title: 'sh', status: 'ready', terminal: 'term_1' },
        { type: 'file', id: 'f1', title: 'a.ts', relativePath: 'src/a.ts' }
      ]
    }
  ]
}

function registry(pane: PaneStub, result: unknown = snapshot) {
  const client = { call: vi.fn(async () => ({ result })) }
  const reg = new SessionTabsRegistry(
    client as never,
    pane as never,
    () => 'wt-1',
    () => {}
  )
  return { reg, client }
}

describe('SessionTabsRegistry.reload', () => {
  it('groups tabs by worktree from session.tabs.listAll', async () => {
    const { reg } = registry(paneStub())
    await reg.reload()
    expect(reg.forWorktree('wt-1').map((t) => `${t.kind}:${t.id}`)).toEqual([
      'terminal:t1',
      'file:f1'
    ])
  })

  it('keeps the previous map when the RPC rejects', async () => {
    const pane = paneStub()
    const client = { call: vi.fn(async () => ({ result: snapshot })) }
    const reg = new SessionTabsRegistry(
      client as never,
      pane as never,
      () => 'wt-1',
      () => {}
    )
    await reg.reload()
    client.call.mockRejectedValueOnce(new Error('down'))
    await reg.reload()
    expect(reg.forWorktree('wt-1')).toHaveLength(2)
  })
})

describe('SessionTabsRegistry.ensureFocused', () => {
  it('refreshes the same focused tab in place', async () => {
    const pane = paneStub({ tabId: 't1' })
    const { reg } = registry(pane)
    await reg.reload()
    reg.ensureFocused()
    expect(pane.refresh).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
    expect(pane.setTab).not.toHaveBeenCalled()
  })

  it('selects the first tab when the focused tab is gone', async () => {
    const pane = paneStub({ tabId: 'missing' })
    const { reg } = registry(pane)
    await reg.reload()
    reg.ensureFocused()
    expect(pane.setTab).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
  })

  it('does not switch away from a dirty editor on a transient drop', async () => {
    const pane = paneStub({ tabId: 'missing', editState: 'dirty' })
    const { reg } = registry(pane)
    await reg.reload()
    reg.ensureFocused()
    expect(pane.setTab).not.toHaveBeenCalled()
  })
})

describe('SessionTabsRegistry.focusOpened', () => {
  it('activates and focuses the tab matching a just-opened path', async () => {
    const pane = paneStub()
    const { reg, client } = registry(pane)
    await reg.reload()
    reg.focusOpened('src/a.ts')
    expect(pane.setTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }))
    expect(pane.focusInput).toHaveBeenCalled()
    expect(client.call).toHaveBeenCalledWith(
      'session.tabs.activate',
      expect.objectContaining({ tabId: 'f1' })
    )
  })
})
