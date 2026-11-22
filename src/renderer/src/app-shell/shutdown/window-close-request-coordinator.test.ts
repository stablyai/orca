import { expect, it, vi } from 'vitest'
import {
  claimCombinedDiffView,
  releaseCombinedDiffView
} from '@/components/editor/combined-diff/remember-view/combined-diff-view-cache'
import { registerMountedCombinedDiffDrafts } from '@/components/editor/combined-diff/remember-view/combined-diff-close-drafts'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../../shared/app-lifecycle/shutdown/renderer-shutdown-events'
import {
  abandonWorkbenchWindowClose,
  cancelWindowCloseRequest,
  confirmInteractiveWindowClose,
  dispatchWindowCloseRequest,
  registerCombinedDiffClosePrompt,
  setWindowCloseRequestHandler,
  type WindowCloseAttempt
} from './window-close-request-coordinator'

function closeHarness(confirm: () => Promise<boolean>) {
  const counts = { cancelled: 0, closed: 0, reset: 0 }
  const ui = {
    cancelWindowClose: () => {
      counts.cancelled++
    },
    confirmWindowClose: () => {
      counts.closed++
    }
  }
  const window = Object.assign(new EventTarget(), {
    api: { app: { awaitBeforeUnloadCheckpoint: async () => {} }, ui }
  })
  vi.stubGlobal('window', window)
  const unregisterPrompt = registerCombinedDiffClosePrompt(confirm)
  window.addEventListener(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT, () => {
    counts.reset++
  })
  return {
    counts,
    ui,
    cleanup() {
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
      unregisterPrompt()
      setWindowCloseRequestHandler(null)
      vi.unstubAllGlobals()
    }
  }
}

function mountedDraft() {
  const lease = claimCombinedDiffView('failure-test', 'workspace')
  const unregister = registerMountedCombinedDiffDrafts(lease, () => [
    { key: 'section', dirty: true, modifiedContent: 'draft' }
  ])
  return () => {
    unregister()
    releaseCombinedDiffView(lease)
  }
}

it('releases a rejected workbench discard prompt and processes the next quit', async () => {
  const harness = closeHarness(async () => {
    throw new Error('Rejected discard prompt')
  })
  const removeDraft = mountedDraft()
  let finish: Promise<void> | undefined
  setWindowCloseRequestHandler((attempt) => {
    finish = confirmInteractiveWindowClose(attempt)
  })
  try {
    await dispatchWindowCloseRequest({ isQuitting: true })
    await finish
    removeDraft()
    await dispatchWindowCloseRequest({ isQuitting: true })
    await finish
    expect(harness.counts).toEqual({ cancelled: 1, closed: 1, reset: 0 })
  } finally {
    removeDraft()
    harness.cleanup()
  }
})

it('abandons a prepared checkpoint when the fallback close fails to send', async () => {
  const { counts, ui, cleanup } = closeHarness(async () => true)
  const send = ui.confirmWindowClose
  ui.confirmWindowClose = () => {
    throw new Error('Failed to send close confirmation')
  }
  try {
    await dispatchWindowCloseRequest({ isQuitting: true })
    expect(counts).toEqual({ cancelled: 1, closed: 0, reset: 1 })
    ui.confirmWindowClose = send
    await dispatchWindowCloseRequest({ isQuitting: true })
    expect(counts).toEqual({ cancelled: 1, closed: 1, reset: 1 })
  } finally {
    cleanup()
  }
})

it('ignores a late rejection and duplicate cancel from a superseded attempt', async () => {
  const firstPrompt = Promise.withResolvers<boolean>()
  const secondPrompt = Promise.withResolvers<boolean>()
  const prompts = [firstPrompt.promise, secondPrompt.promise]
  const harness = closeHarness(async () => (await prompts.shift()) ?? false)
  const removeDraft = mountedDraft()
  const finished: Promise<void>[] = []
  const attempts: WindowCloseAttempt[] = []
  setWindowCloseRequestHandler((attempt) => {
    attempts.push(attempt)
    finished.push(confirmInteractiveWindowClose(attempt))
  })
  try {
    await dispatchWindowCloseRequest({ isQuitting: true })
    cancelWindowCloseRequest(attempts[0])
    await dispatchWindowCloseRequest({ isQuitting: true })
    firstPrompt.reject(new Error('Late rejection'))
    await finished[0]
    cancelWindowCloseRequest(attempts[0])
    secondPrompt.resolve(true)
    await finished[1]
    expect(harness.counts).toEqual({ cancelled: 1, closed: 1, reset: 0 })
  } finally {
    removeDraft()
    harness.cleanup()
  }
})

it('releases a close abandoned by an unmounted workbench and ignores its stale continuation', async () => {
  const harness = closeHarness(async () => true)
  let workbenchAttempt: WindowCloseAttempt | undefined
  setWindowCloseRequestHandler((attempt) => {
    workbenchAttempt = attempt
  })
  try {
    await dispatchWindowCloseRequest({ isQuitting: true })
    abandonWorkbenchWindowClose()
    abandonWorkbenchWindowClose()
    setWindowCloseRequestHandler(null)
    await dispatchWindowCloseRequest({ isQuitting: true })
    if (workbenchAttempt) {
      await confirmInteractiveWindowClose(workbenchAttempt)
    }
    expect(harness.counts).toEqual({ cancelled: 1, closed: 1, reset: 0 })
  } finally {
    harness.cleanup()
  }
})
