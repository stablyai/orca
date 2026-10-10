import { describe, expect, it } from 'vitest'

import {
  countFocusRoutingCalls,
  countFocusSettingReads,
  diffCounts,
  formatBaseline,
  hasFocusRoutingAlias,
  isScannedPath,
  parseBaseline,
  parseBaselineNotes
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

describe('countFocusSettingReads', () => {
  it('counts setting reads, the helpers and the creation default together', () => {
    const src = [
      "import { defaultCreationHost } from './default-creation-host'",
      'const a = settings?.activeRuntimeEnvironmentId',
      'const b = state.settings.activeRuntimeEnvironmentId',
      "const c = settings['activeRuntimeEnvironmentId']",
      'const d = getActiveRuntimeTarget(settings)',
      'const e = defaultCreationHost(settings)',
      'export function defaultCreationHost(settings) {}'
    ].join('\n')
    expect(countFocusSettingReads(src)).toBe(5)
  })

  it('counts a shared focus helper, so wrapping one in an owner transport lowers nothing', () => {
    expect(
      countFocusSettingReads(
        'const t = runtimeTargetForOwnerHostId(getSettingsFocusedExecutionHostId(s))'
      )
    ).toBe(1)
    expect(countFocusSettingReads('const id = getSingleFocusedRuntimeEnvironmentId(state)')).toBe(1)
  })

  it('counts destructuring reads', () => {
    expect(countFocusSettingReads('const { activeRuntimeEnvironmentId } = s')).toBe(1)
    expect(
      countFocusSettingReads(
        "const { theme, activeRuntimeEnvironmentId: id }: Pick<GlobalSettings, 'theme'> = s"
      )
    ).toBe(1)
  })

  it('does not count writes, keys, props or type positions', () => {
    const src = [
      'const owner = { activeRuntimeEnvironmentId: id }',
      'settings = { ...settings, activeRuntimeEnvironmentId: null }',
      "type T = GlobalSettings['activeRuntimeEnvironmentId']",
      'updateSettings({ activeRuntimeEnvironmentId: null })',
      'const f = ({ activeRuntimeEnvironmentId }) => activeRuntimeEnvironmentId',
      'if (a === b) { x = { activeRuntimeEnvironmentId } }'
    ].join('\n')
    expect(countFocusSettingReads(src)).toBe(0)
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
    expect(hasFocusRoutingAlias("import { defaultCreationHost as host } from './d'")).toBe(true)
    expect(
      hasFocusRoutingAlias("import { getSettingsFocusedExecutionHostId as h } from './e'")
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

  it('keeps a row note through a prune', () => {
    const text = formatBaseline(
      new Map([['src/a.ts', 1]]),
      ['# header'],
      new Map([['src/a.ts', 'waits for V4b']])
    )
    expect(text).toBe('# header\n1 src/a.ts # waits for V4b\n')
    expect(parseBaseline(text)).toEqual(new Map([['src/a.ts', 1]]))
    expect(parseBaselineNotes(text)).toEqual(new Map([['src/a.ts', 'waits for V4b']]))
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
