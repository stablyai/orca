import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runOxlintPluginOnSource } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/app-store-performance.mjs')

function lintSource(source) {
  return runOxlintPluginOnSource({
    pluginName: 'app-store-performance',
    pluginPath,
    source,
    rules: {
      'app-store-performance/require-selector': 'warn',
      'app-store-performance/no-identity-selector': 'warn',
      'app-store-performance/no-fresh-selector-result': 'warn',
      'app-store-performance/no-nested-fresh-under-shallow': 'warn'
    }
  })
}

describe('app store performance Oxlint plugin', () => {
  it('reports whole-store and fresh-reference subscriptions', () => {
    const diagnostics = lintSource(`
      import { useAppStore as useStore } from '@/store'
      const WholeStore = () => useStore()
      const Identity = () => useStore((state) => state)
      const Fresh = () => useStore((state) => ({ active: state.active }))
      const Conditional = () => useStore((state) => state.active ? state.items : [])
      const Nested = () => useStore((state) => {
        if (state.active) return state.items.filter(Boolean)
        return state.items
      })
    `)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(require-selector)',
      'app-store-performance(no-identity-selector)',
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-fresh-selector-result)'
    ])
  })

  it('allows focused, cached, and useShallow selectors', () => {
    const diagnostics = lintSource(`
      import { useAppStore } from '@/store'
      import { useShallow as shallow } from 'zustand/react/shallow'
      const selectActive = (state) => state.active
      const Focused = () => useAppStore(selectActive)
      const Cached = () => useAppStore((state) => state.cachedProjection)
      const Shallow = () => useAppStore(shallow((state) => ({ active: state.active })))
    `)

    expect(diagnostics).toEqual([])
  })

  it('resolves selectors referenced by name, including ones hoisted below the call', () => {
    const diagnostics = lintSource(`
      import { useAppStore } from '@/store'
      const EarlyFresh = () => useAppStore(selectFreshRows)
      const selectFreshRows = (state) => state.rows.filter(Boolean)
      const Stable = () => useAppStore(selectActiveId)
      const selectActiveId = (state) => state.activeId
    `)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-fresh-selector-result)'
    ])
  })

  it('does not let a component-local helper resolve a same-named imported selector', () => {
    const diagnostics = lintSource(`
      import { useAppStore } from '@/store'
      import { selectRows } from './selectors'
      const Other = () => {
        const selectRows = (state) => state.rows.map((row) => row.id)
        return selectRows
      }
      const Imported = () => useAppStore(selectRows)
    `)

    expect(diagnostics).toEqual([])
  })

  it('covers sibling store hooks but not useSyncExternalStore', () => {
    const diagnostics = lintSource(`
      import { usePluginPanelsStore } from '@/store/plugin-panels'
      import { useSyncExternalStore } from 'react'
      const WholePanels = () => usePluginPanelsStore()
      const FreshPanels = () => usePluginPanelsStore((state) => ({ open: state.open }))
      const External = () => useSyncExternalStore(subscribe, () => ({ open: true }))
    `)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(require-selector)',
      'app-store-performance(no-fresh-selector-result)'
    ])
  })

  it('reports fresh references nested inside a useShallow projection', () => {
    const diagnostics = lintSource(`
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      const NestedObject = () => useAppStore(useShallow((state) => ({ ids: state.rows.map((row) => row.id) })))
      const NestedArray = () => useAppStore(useShallow((state) => [state.activeId, state.rows.filter(Boolean)]))
      const Flat = () => useAppStore(useShallow((state) => ({ activeId: state.activeId, rows: state.rows })))
    `)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-nested-fresh-under-shallow)',
      'app-store-performance(no-nested-fresh-under-shallow)'
    ])
  })

  it('follows a selector one hop into a module-scope helper', () => {
    const diagnostics = lintSource(`
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      const buildRows = (state) => state.rows.map((row) => row.id)
      const Delegating = () => useAppStore((state) => buildRows(state))
      const NestedDelegating = () => useAppStore(useShallow((state) => ({ ids: buildRows(state) })))
    `)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-nested-fresh-under-shallow)'
    ])
  })

  it('does not flag a helper that returns a cached reference on some branch', () => {
    const diagnostics = lintSource(`
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      // The identity-caching shape: fresh only on a miss, cached otherwise.
      const selectCachedRows = (state) => cache.get(state.key) ?? state.rows.filter(Boolean)
      const Cached = () => useAppStore((state) => selectCachedRows(state))
      const CachedNested = () => useAppStore(useShallow((state) => ({ rows: selectCachedRows(state) })))
      // An unknown helper cannot be resolved, so it must not be guessed at.
      const External = () => useAppStore((state) => externalBuild(state))
    `)

    expect(diagnostics).toEqual([])
  })
})
