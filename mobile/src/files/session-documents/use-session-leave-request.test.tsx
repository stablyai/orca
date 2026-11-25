import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirtyMarkdownDraft } from './session-document-state'

vi.mock('react-native', () => ({ Keyboard: { dismiss: () => {} } }))
const { useSessionLeaveRequest } = await import('./use-session-leave-request')

type Leave = ReturnType<typeof useSessionLeaveRequest>
let leave: Leave
let drafts: DirtyMarkdownDraft[] = []
let revision = 1
let sheet: DirtyMarkdownDraft[] | null = null
const dropDrafts = vi.fn()
const leaveSession = vi.fn()

function Probe({ tick }: { tick: number }) {
  void tick
  leave = useSessionLeaveRequest({
    readDrafts: () => drafts,
    readRevisions: () => drafts.map((draft) => `${draft.tabId}:${revision}`).join(','),
    setLeaveDrafts: (next) => {
      sheet = next
    },
    dropDrafts,
    leaveSession
  })
  return null
}

// A held Copy must not drop newer drafts, touch a newer sheet, or run a delete nobody still asked for.
describe('useSessionLeaveRequest', () => {
  let renderer: ReactTestRenderer | undefined
  let tick = 0
  const rerender = async () => act(async () => renderer?.update(<Probe tick={++tick} />))
  beforeEach(async () => {
    drafts = [{ tabId: 't1', title: 'Notes', content: 'v1' }]
    revision = 1
    sheet = null
    dropDrafts.mockReset()
    leaveSession.mockReset()
    await act(async () => {
      renderer = create(<Probe tick={tick} />)
    })
  })
  afterEach(() => act(() => renderer?.unmount()))

  it('settles once, on the drafts it showed', async () => {
    const handoff = { run: vi.fn(), valid: () => true }
    act(() => leave.requestLeave(handoff))
    const ticket = leave.beginLeave()
    expect(ticket).not.toBeNull()
    expect(leave.beginLeave()).toBeNull()
    act(() => leave.finishLeave(ticket!))
    expect(dropDrafts).toHaveBeenCalledWith(drafts)
    expect(handoff.run).toHaveBeenCalledTimes(1)
    expect(leaveSession).not.toHaveBeenCalled()
  })

  it('does nothing when the drafts were edited while Copy was held', async () => {
    const handoff = { run: vi.fn(), valid: () => true }
    act(() => leave.requestLeave(handoff))
    const ticket = leave.beginLeave()!
    revision = 2
    await rerender()
    act(() => leave.finishLeave(ticket))
    expect(dropDrafts).not.toHaveBeenCalled()
    expect(handoff.run).not.toHaveBeenCalled()
  })

  it('checks the revisions again when the Copy lands, and revokes on a rendered edit', async () => {
    const handoff = { run: vi.fn(), valid: () => true }
    act(() => leave.requestLeave(handoff))
    const ticket = leave.beginLeave()!
    revision = 2
    act(() => leave.finishLeave(ticket))
    expect(dropDrafts).not.toHaveBeenCalled()
    revision = 1
    act(() => leave.requestLeave(handoff))
    revision = 3
    await rerender()
    expect(leave.beginLeave()).toBeNull()
    expect(handoff.run).not.toHaveBeenCalled()
  })

  it('leaves a newer leave and its sheet alone when an older Copy lands', async () => {
    const handoff = { run: vi.fn(), valid: () => true }
    act(() => leave.requestLeave(handoff))
    const old = leave.beginLeave()!
    act(() => leave.requestLeave())
    act(() => leave.finishLeave(old))
    expect(sheet).toEqual(drafts)
    expect(dropDrafts).not.toHaveBeenCalled()
    expect(handoff.run).not.toHaveBeenCalled()
  })

  it('arms nothing after the sheet is closed or the origin is gone', async () => {
    const handoff = { run: vi.fn(), valid: () => true }
    act(() => leave.requestLeave(handoff))
    leave.closeLeave()
    expect(leave.beginLeave()).toBeNull()
    const stale = { run: vi.fn(), valid: () => false }
    act(() => leave.requestLeave(stale))
    act(() => leave.finishLeave(leave.beginLeave()!))
    expect(dropDrafts).not.toHaveBeenCalled()
    expect(stale.run).not.toHaveBeenCalled()
  })
})
