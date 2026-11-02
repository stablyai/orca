import { describe, expect, it } from 'vitest'

import {
  countFocusSettingReads,
  countForbiddenHelperUses,
  discoverFocusReaders,
  hasFocusRoutingAlias,
  isScannedPath
} from './check-focus-read-ratchet.mjs'

describe('countForbiddenHelperUses', () => {
  it('counts calls and value uses of the deleted helpers, not definitions, types or imports', () => {
    const src = [
      "import { callRuntimeRpc, getActiveRuntimeTarget } from './rpc'",
      "export {\n  settingsForRuntimeOwner,\n  type RuntimeClientTarget\n} from './target'",
      'const a = getActiveRuntimeTarget (settingsForRuntimeOwner(settings, id))',
      'const b = list.map(legacyRouteFromSettings)',
      'export function getActiveRuntimeTarget(settings) {}',
      'type T = ReturnType<typeof getActiveRuntimeTarget>',
      'mygetActiveRuntimeTarget(settings)'
    ].join('\n')
    expect(countForbiddenHelperUses(src)).toBe(3)
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

  it('discovers readers through imports, so a look-alike or a wrapper lowers nothing', () => {
    const readers = discoverFocusReaders(
      new Map([
        [
          'src/shared/execution-host.ts',
          'export function getSettingsFocusedExecutionHostId(settings) {\n  return settings?.activeRuntimeEnvironmentId\n}\n'
        ],
        [
          'src/renderer/src/a.ts',
          [
            "import { getSettingsFocusedExecutionHostId } from '../../shared/execution-host'",
            'export function getAutomationListTarget(settings) {',
            '  const id = settings?.activeRuntimeEnvironmentId?.trim()',
            "  return id ? { kind: 'environment', environmentId: id } : { kind: 'local' }",
            '}',
            'export const cacheKey = (s) => `k:${getActiveRuntimeTarget(s).kind}`',
            'export function browserHostId(state, override) {',
            '  return override ?? getSettingsFocusedExecutionHostId(state.settings)',
            '}',
            'export function wrappedTwice(state) {',
            '  return browserHostId(state, null)',
            '}',
            'export function ownerTarget(row) {',
            '  return row.owner',
            '}',
            'export function SettingsPane() {',
            '  return getAutomationListTarget(null)',
            '}'
          ].join('\n')
        ],
        [
          'src/renderer/src/harness.ts',
          'export const ownerTarget = (s) => s.activeRuntimeEnvironmentId'
        ],
        [
          'src/renderer/src/b.ts',
          [
            "import { browserHostId, wrappedTwice, ownerTarget, SettingsPane } from './a'",
            'const a = wrappedTwice(state)',
            'const b = ownerTarget(row)',
            'const c = <SettingsPane />'
          ].join('\n')
        ]
      ])
    )
    const inA = readers.namesFor('src/renderer/src/a.ts')
    for (const name of ['getAutomationListTarget', 'cacheKey', 'browserHostId', 'wrappedTwice']) {
      expect(inA.has(name)).toBe(true)
    }
    expect(inA.has('ownerTarget')).toBe(false)
    expect(inA.has('SettingsPane')).toBe(false)
    // `ownerTarget` from `./a` is not the harness's same-named reader.
    expect(
      [...readers.namesFor('src/renderer/src/b.ts')].filter((n) => !n.startsWith('get'))
    ).toEqual(expect.arrayContaining(['browserHostId', 'wrappedTwice']))
    expect(readers.namesFor('src/renderer/src/b.ts').has('ownerTarget')).toBe(false)
    expect(
      countFocusSettingReads(
        'const t = ipcOrRuntimeTargetForHostId(getSettingsFocusedExecutionHostId(s))',
        readers.namesFor('src/renderer/src/a.ts')
      )
    ).toBe(1)
    expect(
      countFocusSettingReads(
        "import { wrappedTwice } from './a'\nconst t = wrappedTwice(state)",
        readers.namesFor('src/renderer/src/b.ts')
      )
    ).toBe(1)
    expect(countFocusSettingReads('export const cacheKey = (s) => s', inA)).toBe(0)
  })

  it('counts a reader called through a namespace or dynamic import', () => {
    const readers = discoverFocusReaders(
      new Map([
        [
          'src/renderer/src/routing.ts',
          'export function focusedHostId(s) {\n  return s.activeRuntimeEnvironmentId\n}\n'
        ],
        [
          'src/renderer/src/wrap.ts',
          "import * as rr from './routing'\nexport function hostOf(s) {\n  return rr.focusedHostId(s)\n}\n"
        ],
        [
          'src/renderer/src/use.ts',
          "const { focusedHostId } = await import('./routing')\nconst a = focusedHostId(s)\n"
        ]
      ])
    )
    expect(readers.has('hostOf')).toBe(true)
    expect(
      countFocusSettingReads(
        "import * as rr from './routing'\nconst a = rr.focusedHostId(s)\nt('auto.rr.focusedHostId.x')",
        readers.namesFor('src/renderer/src/other.ts'),
        readers.memberNames
      )
    ).toBe(1)
    expect(
      countFocusSettingReads(
        "const { focusedHostId } = await import('./routing')\nconst a = focusedHostId(s)\n",
        readers.namesFor('src/renderer/src/use.ts'),
        readers.memberNames
      )
    ).toBe(1)
    for (const [rel, text] of [
      ['src/renderer/src/r1.ts', "const { focusedHostId: g } = await import('./routing')\ng(s)"],
      [
        'src/renderer/src/r2.ts',
        "const { focusedHostId } = (await import('./routing'))\nfocusedHostId(s)"
      ],
      [
        'src/renderer/src/r3.ts',
        "void import('./routing').then(({ focusedHostId }) => focusedHostId(s))"
      ]
    ]) {
      const withFile = discoverFocusReaders(
        new Map([
          [
            'src/renderer/src/routing.ts',
            'export function focusedHostId(s) {\n  return s.activeRuntimeEnvironmentId\n}\n'
          ],
          [rel, text]
        ])
      )
      expect(countFocusSettingReads(text, withFile.namesFor(rel), withFile.memberNames)).toBe(1)
    }
  })

  it('discovers a reader assigned to a local that is then returned', () => {
    const readers = discoverFocusReaders(
      new Map([
        [
          'src/renderer/src/focus.ts',
          'export function focusedId(s) {\n  return s.activeRuntimeEnvironmentId\n}\n'
        ],
        [
          'src/renderer/src/hook.ts',
          [
            "import { focusedId } from './focus'",
            'export function useTarget(s) {',
            '  const id = focusedId(s)',
            '  const unrelated = focusedId(s)',
            '  return id ? { id } : null',
            '}',
            'export function sideEffectOnly(s) {',
            '  const id = focusedId(s)',
            '  log(id)',
            '  return null',
            '}'
          ].join('\n')
        ]
      ])
    )
    expect(readers.namesFor('src/renderer/src/hook.ts').has('useTarget')).toBe(true)
    expect(readers.namesFor('src/renderer/src/hook.ts').has('sideEffectOnly')).toBe(false)
  })

  it('counts the default scope source as a read', () => {
    expect(countFocusSettingReads('linearConnect(defaultScopeSource(get().settings), key)')).toBe(1)
  })

  it('counts destructuring reads', () => {
    expect(countFocusSettingReads('const { activeRuntimeEnvironmentId } = s')).toBe(1)
    expect(
      countFocusSettingReads('const { settings: { activeRuntimeEnvironmentId } } = state')
    ).toBe(1)
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
    expect(hasFocusRoutingAlias("import { getActiveRuntimeTarget } from './rpc'")).toBe(false)
  })
})

describe('isScannedPath', () => {
  it('scans renderer sources but not tests', () => {
    expect(isScannedPath('src/renderer/src/a.ts')).toBe(true)
    expect(isScannedPath('src/renderer/src/a.tsx')).toBe(true)
    expect(isScannedPath('src/renderer/src/a.test.ts')).toBe(false)
    expect(isScannedPath('src/renderer/src/a.spec.tsx')).toBe(false)
    expect(isScannedPath('src/renderer/src/a.test-fixture.ts')).toBe(false)
  })
})
