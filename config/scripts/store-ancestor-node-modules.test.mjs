import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeModulesAboveStore } from './store-ancestor-node-modules.mjs'

const slot = join(
  '/',
  'home',
  'dev',
  'pnpm',
  'store',
  'v11',
  'links',
  '@',
  'zod',
  '4.6.5',
  'h',
  'node_modules',
  'zod'
)

describe('nodeModulesAboveStore', () => {
  it('reports node_modules above the store root, not the slot-local ones', () => {
    const present = new Set([
      join('/', 'home', 'dev', 'node_modules'),
      join(
        '/',
        'home',
        'dev',
        'pnpm',
        'store',
        'v11',
        'links',
        '@',
        'zod',
        '4.6.5',
        'h',
        'node_modules'
      )
    ])
    expect(nodeModulesAboveStore(slot, (path) => present.has(path))).toEqual([
      join('/', 'home', 'dev', 'node_modules')
    ])
  })

  it('reports nothing for a clean store or a path outside any store', () => {
    expect(nodeModulesAboveStore(slot, () => false)).toEqual([])
    expect(nodeModulesAboveStore(join('/', 'repo', 'node_modules', 'zod'), () => true)).toEqual([])
  })
})
