// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import {
  selectAppRootSurfacePetEnabled,
  selectAppRootSurfaceTelemetryOptedIn,
  selectAppRootSurfaceVoiceEnabled
} from './app-root-surface-settings'

type SurfaceState = Parameters<typeof selectAppRootSurfaceVoiceEnabled>[0]

describe('app root surface settings selectors', () => {
  it('does not rerender for an unrelated settings replacement', () => {
    const store = createStore<SurfaceState>(() => ({ settings: getDefaultSettings('/tmp') }))
    let renderCount = 0
    const view = renderHook(() => {
      renderCount += 1
      return {
        voiceEnabled: useStore(store, selectAppRootSurfaceVoiceEnabled),
        petEnabled: useStore(store, selectAppRootSurfacePetEnabled),
        telemetryOptedIn: useStore(store, selectAppRootSurfaceTelemetryOptedIn)
      }
    })

    expect(renderCount).toBe(1)
    act(() => {
      const settings = store.getState().settings!
      store.setState({ settings: { ...settings, editorAutoSave: !settings.editorAutoSave } })
    })

    expect(renderCount).toBe(1)
    expect(view.result.current.voiceEnabled).toBe(false)
    expect(view.result.current.petEnabled).toBe(false)
    expect(view.result.current.telemetryOptedIn).toBe('unknown')
    view.unmount()
  })

  it('still rerenders when a setting used by a surface changes', () => {
    const store = createStore<SurfaceState>(() => ({ settings: getDefaultSettings('/tmp') }))
    let renderCount = 0
    const view = renderHook(() => {
      renderCount += 1
      return useStore(store, selectAppRootSurfaceVoiceEnabled)
    })

    act(() => {
      const settings = store.getState().settings!
      store.setState({ settings: { ...settings, voice: { ...settings.voice!, enabled: true } } })
    })

    expect(renderCount).toBe(2)
    view.unmount()
  })
})
