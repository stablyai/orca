import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const pluginPath = path.resolve('config/oxlint-plugins/app-store-performance.mjs')
const oxlintPath = path.resolve(
  process.platform === 'win32' ? 'node_modules/.bin/oxlint.cmd' : 'node_modules/.bin/oxlint'
)

function lintSource(source) {
  const directory = mkdtempSync(path.join(tmpdir(), 'orca-app-store-lint-'))
  const sourcePath = path.join(directory, 'sample.tsx')
  const configPath = path.join(directory, 'oxlint.json')
  writeFileSync(sourcePath, source)
  writeFileSync(
    configPath,
    JSON.stringify({
      categories: {
        correctness: 'off'
      },
      jsPlugins: [{ name: 'app-store-performance', specifier: pluginPath }],
      rules: {
        'app-store-performance/require-selector': 'warn',
        'app-store-performance/no-identity-selector': 'warn',
        'app-store-performance/no-fresh-selector-result': 'warn'
      }
    })
  )
  const result = spawnSync(oxlintPath, ['--config', configPath, '--format', 'json', sourcePath], {
    encoding: 'utf8'
  })
  if (result.error) {
    throw result.error
  }
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout).diagnostics
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
})
