import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/app-store-performance.mjs')

function lintSources(sources) {
  return runOxlintPluginOnSources({
    pluginName: 'app-store-performance',
    pluginPath,
    sources,
    rules: {
      'app-store-performance/require-selector': 'warn',
      'app-store-performance/no-identity-selector': 'warn',
      'app-store-performance/no-whole-hot-map-selector': 'warn',
      'app-store-performance/no-fresh-selector-result': 'warn',
      'app-store-performance/no-nested-fresh-under-shallow': 'warn'
    }
  })
}

const sources = {
  hotMapReturns: `
      import { useAppStore as useStore } from '@/store'
      import { useRuntimeStore } from '@/store/runtime'
      import { useShallow } from 'zustand/react/shallow'
      const Direct = () => useStore(s => s.runtimeStatusByEnvironmentId)
      const Block = () => useStore(state => { return state.runtimeStatusByEnvironmentId })
      const Alias = () => useStore(state => { const statuses = state.runtimeStatusByEnvironmentId; return statuses })
      const StateAlias = () => useStore(state => { const snapshot = state; return snapshot.runtimeStatusByEnvironmentId })
      const Destructure = () => useStore(state => { const { runtimeStatusByEnvironmentId: statuses } = state; return statuses })
      const Parameter = () => useStore(({ runtimeStatusByEnvironmentId: statuses }) => statuses)
      const Named = () => useStore(selectStatuses)
      function selectStatuses(state) { return state.runtimeStatusByEnvironmentId }
      const Sibling = () => useRuntimeStore(s => s.runtimeStatusByEnvironmentId)
      const ShallowMap = () => useStore(useShallow(s => s.runtimeStatusByEnvironmentId))
    `,
  focusedHotMapReads: `
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      const Primitive = () => useAppStore(s => s.runtimeStatusByEnvironmentId.get(hostId)?.status !== null)
      const NonHot = () => useAppStore(s => s.someOtherMap)
      const Action = () => useAppStore(s => s.action)
      const onClick = () => useAppStore.getState().runtimeStatusByEnvironmentId
      const Shallow = () => useAppStore(useShallow(s => ({ online: Boolean(s.runtimeStatusByEnvironmentId.get(hostId)?.status) })))
      const OtherObject = () => useAppStore(s => other.runtimeStatusByEnvironmentId)
      const Shadow = () => useAppStore(s => { const statuses = other.runtimeStatusByEnvironmentId; return statuses })
      function ShadowedHook(useAppStore) { return useAppStore(s => s.runtimeStatusByEnvironmentId) }
      const ShadowedParameter = () => useAppStore(s => { { const s = other; return s.runtimeStatusByEnvironmentId } })
    `,
  subscriptions: `
      import { useAppStore as useStore } from '@/store'
      const WholeStore = () => useStore()
      const Identity = () => useStore((state) => state)
      const Fresh = () => useStore((state) => ({ active: state.active }))
      const Conditional = () => useStore((state) => state.active ? state.items : [])
      const Nested = () => useStore((state) => {
        if (state.active) return state.items.filter(Boolean)
        return state.items
      })
    `,
  namedSelectors: `
      import { useAppStore } from '@/store'
      const EarlyFresh = () => useAppStore(selectFreshRows)
      function selectFreshRows(state) { return state.rows.filter(Boolean) }
      const Stable = () => useAppStore(selectActiveId)
      const selectActiveId = (state) => state.activeId
    `,
  nestedShallow: `
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      const NestedObject = () => useAppStore(useShallow((state) => ({ ids: state.rows.map((row) => row.id) })))
      const NestedArray = () => useAppStore(useShallow((state) => [state.activeId, state.rows.filter(Boolean)]))
      const Flat = () => useAppStore(useShallow((state) => ({ activeId: state.activeId, rows: state.rows })))
    `,
  delegatingSelectors: `
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      const buildRows = (state) => state.rows.map((row) => row.id)
      const Delegating = () => useAppStore((state) => buildRows(state))
      const NestedDelegating = () => useAppStore(useShallow((state) => ({ ids: buildRows(state) })))
    `,
  lexicalBindings: `
      import { useAppStore } from '@/store'
      const select = s => ({ active: s.active })
      const build = s => s.rows.map(row => row.id)
      function View() {
        const select = s => s.active, build = s => s.rows
        useAppStore(select)
        return useAppStore(s => build(s))
      }
      export function useTargetState(options) { useAppStore(options); return { options } }
    `,
  shadowedImports: `
      import { useAppStore, useAppStore as useStore } from '@/store'
      import { usePluginPanelsStore as usePanels } from '@/store/plugin-panels'
      import { useShallow as shallow } from 'zustand/react/shallow'
      function View(useStore, usePanels, shallow) {
        useStore(); usePanels()
        return useAppStore(shallow(s => ({ ids: s.rows.map(row => row.id) })))
      }
    `,
  cachedHelpers: `
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      // The identity-caching shape: fresh only on a miss, cached otherwise.
      const cache = new WeakMap()
      const selectCachedRows = (state) => cache.get(state.key) ?? state.rows.filter(Boolean)
      const Cached = () => useAppStore((state) => selectCachedRows(state))
      const CachedNested = () => useAppStore(useShallow((state) => ({ rows: selectCachedRows(state) })))
      // An unknown helper cannot be resolved, so it must not be guessed at.
      const External = () => useAppStore((state) => externalBuild(state))
    `
}

const diagnosticsBySource = new Map()
beforeAll(() => {
  const fixtures = Object.values(sources)
  lintSources(fixtures).forEach((diagnostics, index) => {
    diagnosticsBySource.set(fixtures[index], diagnostics)
  })
})

describe('app store performance Oxlint plugin', () => {
  it('reports whole hot-map returns through local bindings', () => {
    expect(
      diagnosticsBySource.get(sources.hotMapReturns).map((diagnostic) => diagnostic.code)
    ).toEqual(Array(9).fill('app-store-performance(no-whole-hot-map-selector)'))
  })

  it('allows stable projections of hot-map fields', () => {
    expect(diagnosticsBySource.get(sources.focusedHotMapReads)).toEqual([])
  })

  it.each(['lexicalBindings', 'shadowedImports'])('respects lexical bindings in %s', (name) => {
    expect(diagnosticsBySource.get(sources[name])).toEqual([])
  })

  it('reports whole-store and fresh-reference subscriptions', () => {
    const diagnostics = diagnosticsBySource.get(sources.subscriptions)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(require-selector)',
      'app-store-performance(no-identity-selector)',
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-fresh-selector-result)'
    ])
  })

  it('resolves selectors referenced by name, including ones hoisted below the call', () => {
    const diagnostics = diagnosticsBySource.get(sources.namedSelectors)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-fresh-selector-result)'
    ])
  })

  it('reports fresh references nested inside a useShallow projection', () => {
    const diagnostics = diagnosticsBySource.get(sources.nestedShallow)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-nested-fresh-under-shallow)',
      'app-store-performance(no-nested-fresh-under-shallow)'
    ])
  })

  it('follows a selector one hop into a module-scope helper', () => {
    const diagnostics = diagnosticsBySource.get(sources.delegatingSelectors)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-nested-fresh-under-shallow)'
    ])
  })

  it('does not flag a helper that returns a cached reference on some branch', () => {
    const diagnostics = diagnosticsBySource.get(sources.cachedHelpers)

    expect(diagnostics).toEqual([])
  })
})
