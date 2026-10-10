import { describe, expect, it } from 'vitest'

import {
  countFocusRoutingCalls,
  diffCounts,
  formatBaseline,
  hasFocusRoutingAlias,
  isScannedPath,
  parseBaseline
} from './check-owner-routing-ratchet.mjs'

describe('countFocusRoutingCalls', () => {
  it('counts the three focus-routing helpers together', () => {
    const src = [
      'const a = getActiveRuntimeTarget(settings)',
      'const b = legacyRouteFromSettings(settings)',
      'const c = getActiveRuntimeTarget(settingsForRuntimeOwner(settings, id))'
    ].join('\n')
    expect(countFocusRoutingCalls(src)).toBe(4)
  })

  it('ignores definitions, type queries and longer names', () => {
    const src = [
      'export function getActiveRuntimeTarget(settings) {}',
      'type T = ReturnType<typeof getActiveRuntimeTarget>',
      'mygetActiveRuntimeTarget(settings)'
    ].join('\n')
    expect(countFocusRoutingCalls(src)).toBe(0)
  })

  it('counts spaced calls and value uses but not import or export lists', () => {
    const src = [
      "import { callRuntimeRpc, getActiveRuntimeTarget } from './rpc'",
      "export {\n  settingsForRuntimeOwner,\n  type RuntimeClientTarget\n} from './target'",
      'const a = getActiveRuntimeTarget (settings)',
      'const b = list.map(getActiveRuntimeTarget)'
    ].join('\n')
    expect(countFocusRoutingCalls(src)).toBe(2)
  })
})

describe('hasFocusRoutingAlias', () => {
  it('refuses an aliased import or re-export, which would hide its calls', () => {
    expect(hasFocusRoutingAlias("import { getActiveRuntimeTarget as route } from './rpc'")).toBe(
      true
    )
    expect(
      hasFocusRoutingAlias("export {\n  settingsForRuntimeOwner as owner\n} from './target'")
    ).toBe(true)
    expect(hasFocusRoutingAlias("import { getActiveRuntimeTarget } from './rpc'")).toBe(false)
  })
})

describe('isScannedPath', () => {
  it('scans renderer sources but not tests', () => {
    expect(isScannedPath('src/renderer/src/a.ts')).toBe(true)
    expect(isScannedPath('src/renderer/src/a.tsx')).toBe(true)
    expect(isScannedPath('src/renderer/src/a.test.ts')).toBe(false)
    expect(isScannedPath('src/renderer/src/a.spec.tsx')).toBe(false)
  })
})

describe('baseline', () => {
  it('round-trips through format and parse, dropping zero rows', () => {
    const counts = new Map([
      ['src/b.ts', 2],
      ['src/a.ts', 1],
      ['src/c.ts', 0]
    ])
    expect(parseBaseline(formatBaseline(counts))).toEqual(
      new Map([
        ['src/a.ts', 1],
        ['src/b.ts', 2]
      ])
    )
  })

  it('fails growth, including a new file, and asks to prune shrinkage', () => {
    const { grown, shrunk } = diffCounts(
      new Map([
        ['src/a.ts', 3],
        ['src/new.ts', 1],
        ['src/b.ts', 1]
      ]),
      new Map([
        ['src/a.ts', 2],
        ['src/b.ts', 2],
        ['src/gone.ts', 1]
      ])
    )
    expect(grown).toEqual([
      { file: 'src/a.ts', now: 3, allowed: 2 },
      { file: 'src/new.ts', now: 1, allowed: 0 }
    ])
    expect(shrunk).toEqual([
      { file: 'src/b.ts', now: 1, allowed: 2 },
      { file: 'src/gone.ts', now: 0, allowed: 1 }
    ])
  })
})
