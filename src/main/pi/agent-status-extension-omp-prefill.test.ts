import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

describe('OMP prefill through the explicitly loaded status extension', () => {
  it('sets a reasonless startup draft once without submitting', async () => {
    const h = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { ORCA_OMP_PREFILL: 'Fix task\nKeep details' }
    })
    const setEditorText = vi.fn()
    await h.callHook('session_start', {}, { ui: { setEditorText } })
    expect(setEditorText).toHaveBeenCalledExactlyOnceWith('Fix task\nKeep details')
    expect(h.processEnv.ORCA_OMP_PREFILL).toBeUndefined()
    await h.callHook('session_start', {}, { ui: { setEditorText } })
    h.reload()
    await h.callHook('session_start', {}, { ui: { setEditorText } })
    expect(setEditorText).toHaveBeenCalledTimes(1)
    expect(h.fetchMock).not.toHaveBeenCalled()
  })

  it('preserves the draft until an editor is available', async () => {
    const h = createAgentStatusExtensionHarness({ kind: 'omp', env: { ORCA_OMP_PREFILL: 'Draft' } })
    await h.callHook('session_start', {}, {})
    expect(h.processEnv.ORCA_OMP_PREFILL).toBe('Draft')
    const noopEditor = vi.fn()
    await h.callHook('session_start', {}, { hasUI: false, ui: { setEditorText: noopEditor } })
    expect(noopEditor).not.toHaveBeenCalled()
    expect(h.processEnv.ORCA_OMP_PREFILL).toBe('Draft')
    const setEditorText = vi.fn()
    await h.callHook('session_start', {}, { ui: { setEditorText } })
    expect(setEditorText).toHaveBeenCalledExactlyOnceWith('Draft')
  })

  it('never consumes a Pi draft in an OMP process', async () => {
    const h = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { ORCA_PI_PREFILL: 'Pi only' }
    })
    const setEditorText = vi.fn()
    await h.callHook('session_start', {}, { ui: { setEditorText } })
    expect(setEditorText).not.toHaveBeenCalled()
    expect(h.processEnv.ORCA_PI_PREFILL).toBe('Pi only')
  })

  it('leaves the draft alone outside an Orca pane', async () => {
    const h = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { ORCA_PANE_KEY: undefined, ORCA_OMP_PREFILL: 'Draft' }
    })
    const setEditorText = vi.fn()
    await h.callHook('session_start', {}, { ui: { setEditorText } })
    expect(setEditorText).not.toHaveBeenCalled()
    expect(h.processEnv.ORCA_OMP_PREFILL).toBe('Draft')
  })
  it('does not let a nested process consume the owner draft', () => {
    const h = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { ORCA_PI_STATUS_OWNED: '999', ORCA_OMP_PREFILL: 'Owner draft' }
    })
    expect(h.handlers.session_start).toBeUndefined()
    expect(h.processEnv.ORCA_OMP_PREFILL).toBe('Owner draft')
  })
})
