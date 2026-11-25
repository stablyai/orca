// @vitest-environment happy-dom
// A view of this run only (a share request's page) is never saved: quitting on it leaves the view saved
// before it, and the live writer never sends it.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { usePersistedUIWriter } from '../storage/use-persisted-ui-writer'
import { buildActiveViewUnloadPatch } from './active-view-persist'

const initial = useAppStore.getState()

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

it('quitting on an unsaved view leaves the saved view alone', () => {
  expect(
    buildActiveViewUnloadPatch({ activeView: 'shareRequest', persistedUIReady: true })
  ).toEqual({})
  expect(buildActiveViewUnloadPatch({ activeView: 'settings', persistedUIReady: true })).toEqual({
    activeView: 'settings'
  })
})

it('the live writer sends a saved view, never an unsaved one', () => {
  const set = vi.fn(async (_patch: unknown) => {})
  vi.stubGlobal('api', { ...window.api, ui: { ...window.api?.ui, set } })
  function Writer(): null {
    usePersistedUIWriter()
    return null
  }
  useAppStore.setState({ persistedUIReady: true, activeView: 'shareRequest' })
  const { rerender } = render(<Writer />)
  const sentViews = () =>
    set.mock.calls.flatMap(([patch]) =>
      patch && typeof patch === 'object' && 'activeView' in patch ? [patch.activeView] : []
    )
  expect(sentViews()).toEqual([])
  useAppStore.setState({ activeView: 'settings' })
  rerender(<Writer />)
  expect(sentViews()).toEqual(['settings'])
})
