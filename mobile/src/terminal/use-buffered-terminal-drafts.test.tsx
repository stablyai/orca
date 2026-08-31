import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRetainedTerminalHandles } from '../session/mobile-terminal-prune-decision'
import { useBufferedTerminalDrafts } from './use-buffered-terminal-drafts'

type BufferedDraftHook = ReturnType<typeof useBufferedTerminalDrafts>

let currentHook: BufferedDraftHook | null = null
let renderer: ReactTestRenderer | null = null
let probeRenderCount = 0

function Probe({ activeHandle }: { readonly activeHandle: string | null }) {
  probeRenderCount += 1
  const activeHandleRef = useRef(activeHandle)
  activeHandleRef.current = activeHandle
  currentHook = useBufferedTerminalDrafts({ activeHandle, activeHandleRef })
  return null
}

function hook(): BufferedDraftHook {
  if (!currentHook) {
    throw new Error('Hook probe is not mounted')
  }
  return currentHook
}

afterEach(() => {
  act(() => renderer?.unmount())
  currentHook = null
  probeRenderCount = 0
  renderer = null
})

describe('useBufferedTerminalDrafts', () => {
  it('does not re-render for an unchanged terminal reconciliation', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal' }))
    })
    const initialRenderCount = probeRenderCount
    act(() => {
      hook().reconcileTerminalTabs(
        [{ id: 'tab-1', leafId: 'leaf-1', terminal: 'terminal' }],
        [{ id: 'tab-1', leafId: 'leaf-1', terminal: 'terminal' }]
      )
    })

    expect(probeRenderCount).toBe(initialRenderCount)
  })

  it('does not re-render when terminal-list pruning retains every mapped draft', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal' }))
    })
    act(() => hook().setInput('draft'))
    act(() => {
      hook().reconcileTerminalTabs(
        [{ id: 'tab-1', leafId: 'leaf-1', terminal: 'terminal' }],
        [{ id: 'tab-1', leafId: 'leaf-1', terminal: 'terminal' }]
      )
    })
    const renderCountBeforePrune = probeRenderCount

    act(() => hook().pruneDrafts(new Set()))

    expect(probeRenderCount).toBe(renderCountBeforePrune)
  })

  it('carries an unsent draft through a pending-handle remint', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal-old' }))
    })
    act(() => hook().setInput('keep across reload'))
    act(() => {
      hook().reconcileTerminalTabs(
        [{ id: 'tab-old', leafId: 'leaf-1', terminal: 'terminal-old' }],
        [{ id: 'tab-old', leafId: 'leaf-1', terminal: null }]
      )
      renderer?.update(createElement(Probe, { activeHandle: null }))
    })
    act(() => {
      hook().reconcileTerminalTabs(
        [{ id: 'tab-old', leafId: 'leaf-1', terminal: null }],
        [{ id: 'tab-reminted', leafId: 'leaf-1', terminal: 'terminal-new' }]
      )
      renderer?.update(createElement(Probe, { activeHandle: 'terminal-new' }))
    })

    expect(hook().input).toBe('keep across reload')
  })

  it('carries an unsent draft through a transient empty snapshot and handle remint', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal-old' }))
    })
    act(() => hook().setInput('keep through empty snapshot'))
    act(() => {
      hook().reconcileTerminalTabs(
        [{ id: 'tab-old', leafId: 'leaf-1', terminal: 'terminal-old' }],
        [],
        { retainMissingSurfaces: true }
      )
      renderer?.update(createElement(Probe, { activeHandle: null }))
    })
    act(() => {
      hook().reconcileTerminalTabs(
        [],
        [{ id: 'tab-reminted', leafId: 'leaf-1', terminal: 'terminal-new' }]
      )
      renderer?.update(createElement(Probe, { activeHandle: 'terminal-new' }))
    })

    expect(hook().input).toBe('keep through empty snapshot')
  })

  it('restores a rejected send to its reminted terminal surface', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal-old' }))
    })
    act(() => hook().setInput('rejected command'))
    let send: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      send = hook().beginBufferedTerminalDraftSend('terminal-old', hook().input)
      hook().reconcileTerminalTabs(
        [{ id: 'tab-old', leafId: 'leaf-1', terminal: 'terminal-old' }],
        [{ id: 'tab-reminted', leafId: 'leaf-1', terminal: 'terminal-new' }]
      )
      renderer?.update(createElement(Probe, { activeHandle: 'terminal-new' }))
    })
    act(() => hook().restoreRejectedDraft(send))

    expect(hook().input).toBe('rejected command')
  })

  it('restores a rejected send after a transient empty snapshot remints its surface', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal-old' }))
    })
    act(() => hook().setInput('rejected command'))
    let send: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      send = hook().beginBufferedTerminalDraftSend('terminal-old', hook().input)
      hook().reconcileTerminalTabs(
        [{ id: 'tab-old', leafId: 'leaf-1', terminal: 'terminal-old' }],
        [],
        { retainMissingSurfaces: true }
      )
      hook().reconcileTerminalTabs(
        [],
        [{ id: 'tab-reminted', leafId: 'leaf-1', terminal: 'terminal-new' }]
      )
      renderer?.update(createElement(Probe, { activeHandle: 'terminal-new' }))
    })
    act(() => hook().restoreRejectedDraft(send))

    expect(hook().input).toBe('rejected command')
  })

  it('keeps mapped drafts during terminal-list gaps but prunes them after confirmed close', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal' }))
    })
    act(() => hook().setInput('bounded draft'))
    act(() => {
      hook().reconcileTerminalTabs(
        [{ id: 'tab-1', leafId: 'leaf-1', terminal: 'terminal' }],
        [{ id: 'tab-1', leafId: 'leaf-1', terminal: null }]
      )
      hook().pruneDrafts(new Set())
    })
    expect(hook().input).toBe('bounded draft')

    act(() => {
      hook().reconcileTerminalTabs([{ id: 'tab-1', leafId: 'leaf-1', terminal: null }], [])
      hook().pruneDrafts(new Set())
    })
    expect(hook().input).toBe('')
  })

  it('preserves an intentional clear after the optimistic send clear', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal' }))
    })
    act(() => hook().setInput('rejected command'))
    let send: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      send = hook().beginBufferedTerminalDraftSend('terminal', hook().input)
    })
    act(() => hook().setInput('new command'))
    act(() => hook().setInput(''))
    expect(hook().settleBufferedTerminalDraftSend(send)).toBe(false)
    act(() => hook().restoreRejectedDraft(send))

    expect(hook().input).toBe('')
  })

  it('restores by origin after a tab switch and preserves stable callback identities', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal-a' }))
    })
    const callbacks = {
      begin: hook().beginBufferedTerminalDraftSend,
      prune: hook().pruneDrafts,
      reconcile: hook().reconcileTerminalTabs,
      reset: hook().resetDrafts,
      restore: hook().restoreRejectedDraft,
      setInput: hook().setInput,
      settle: hook().settleBufferedTerminalDraftSend
    }
    act(() => hook().setInput('  echo exact–text  '))
    let send: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      send = hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
      renderer?.update(createElement(Probe, { activeHandle: 'terminal-b' }))
    })
    act(() => hook().setInput('new command for B'))
    act(() => hook().restoreRejectedDraft(send))
    act(() => renderer?.update(createElement(Probe, { activeHandle: 'terminal-a' })))

    expect(hook().input).toBe('  echo exact–text  ')
    expect(hook().beginBufferedTerminalDraftSend).toBe(callbacks.begin)
    expect(hook().pruneDrafts).toBe(callbacks.prune)
    expect(hook().reconcileTerminalTabs).toBe(callbacks.reconcile)
    expect(hook().resetDrafts).toBe(callbacks.reset)
    expect(hook().restoreRejectedDraft).toBe(callbacks.restore)
    expect(hook().setInput).toBe(callbacks.setInput)
    expect(hook().settleBufferedTerminalDraftSend).toBe(callbacks.settle)
  })

  // Why the handle set the session sweep passes matters: terminal.list omits a
  // chat-covered handle while the desktop graph reloads, so the raw list and the
  // retained set disagree exactly there, and only the retained set keeps the draft.
  it('keeps a chat-covered draft against the retained set and drops it against the raw list', () => {
    const listedHandles = new Set(['other-terminal'])
    const retainedHandles = resolveRetainedTerminalHandles({
      liveHandles: listedHandles,
      showNativeChat: true,
      activeHandle: 'covered-terminal'
    })
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'covered-terminal' }))
    })
    act(() => hook().setInput('half-typed command'))

    act(() => hook().pruneDrafts(retainedHandles))
    expect(hook().input).toBe('half-typed command')

    act(() => hook().pruneDrafts(listedHandles))
    expect(hook().input).toBe('')
  })

  it('keeps a chat-covered pending restoration against the retained set only', () => {
    const listedHandles = new Set(['other-terminal'])
    const retainedHandles = resolveRetainedTerminalHandles({
      liveHandles: listedHandles,
      showNativeChat: true,
      activeHandle: 'covered-terminal'
    })
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'covered-terminal' }))
    })
    act(() => hook().setInput('rejected command'))
    let retainedSend: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      retainedSend = hook().beginBufferedTerminalDraftSend('covered-terminal', hook().input)
    })
    act(() => hook().pruneDrafts(retainedHandles))
    act(() => hook().restoreRejectedDraft(retainedSend))
    expect(hook().input).toBe('rejected command')

    let droppedSend: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      droppedSend = hook().beginBufferedTerminalDraftSend('covered-terminal', hook().input)
    })
    act(() => hook().pruneDrafts(listedHandles))
    act(() => hook().restoreRejectedDraft(droppedSend))
    expect(hook().input).toBe('')
  })

  it('drops ended-handle and route-reset restoration metadata', () => {
    act(() => {
      renderer = create(createElement(Probe, { activeHandle: 'terminal' }))
    })
    act(() => hook().setInput('rejected command'))
    let prunedSend: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      prunedSend = hook().beginBufferedTerminalDraftSend('terminal', hook().input)
      hook().reconcileTerminalTabs([{ id: 'tab-1', leafId: 'leaf-1', terminal: 'terminal' }], [])
      hook().restoreRejectedDraft(prunedSend)
    })
    expect(hook().input).toBe('')

    act(() => hook().setInput('route draft'))
    let resetSend: ReturnType<BufferedDraftHook['beginBufferedTerminalDraftSend']>
    act(() => {
      resetSend = hook().beginBufferedTerminalDraftSend('terminal', hook().input)
      hook().resetDrafts()
      hook().restoreRejectedDraft(resetSend)
    })
    expect(hook().input).toBe('')
  })
})
