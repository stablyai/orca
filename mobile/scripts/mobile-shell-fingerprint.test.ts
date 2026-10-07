import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  compareShellFingerprints,
  describePart,
  explainingFiles,
  nativeInputName,
  renderShellVerdictMarkdown
} from './mobile-shell-fingerprint-compare.mjs'
import {
  exportEnvironment,
  moduleDigestsFromSourceMap,
  repoPathOfBundleSource
} from './mobile-shell-fingerprint-export.mjs'
import { nativeSourceEntry, nativeSourcesDigest } from './mobile-shell-fingerprint-native.mjs'

type Bundle = { hash: string; modules: Record<string, string> }

function bundle(hash: string, modules: Record<string, string> = {}): Bundle {
  return { hash, modules }
}

function record(overrides: { nativeAndroid?: string; otaAndroid?: Bundle } = {}) {
  const nativeSources = [{ type: 'contents', id: 'expoConfig', hash: 'c1' }]
  return {
    format: 1,
    native: {
      android: { hash: overrides.nativeAndroid ?? 'n-a', sources: nativeSources },
      ios: { hash: 'n-i', sources: nativeSources }
    },
    shellJs: {
      native: { android: bundle('j-na', { 'mobile/src/a.ts': '1' }), ios: bundle('j-ni') },
      ota: {
        android: overrides.otaAndroid ?? bundle('j-oa', { 'mobile/src/a.ts': '1' }),
        ios: bundle('j-oi')
      }
    }
  }
}

describe('compareShellFingerprints', () => {
  it('reports an identical shell as unchanged', () => {
    const verdict = compareShellFingerprints(record(), record())
    expect(verdict.changed).toBe(false)
    expect(renderShellVerdictMarkdown(verdict)).toBe(
      '### Mobile shell: unchanged — OTA delivers this\n'
    )
  })

  it('names the changed bundle and the module files that explain it', () => {
    const head = record({
      otaAndroid: bundle('j-oa2', {
        'mobile/src/a.ts': '2',
        'mobile/node_modules/@scope/pkg/x.js': '9',
        'mobile/node_modules/@scope/pkg/y.js': '9'
      })
    })
    const verdict = compareShellFingerprints(record(), head)
    expect(verdict.changed).toBe(true)
    expect(renderShellVerdictMarkdown(verdict)).toBe(
      [
        '### Mobile shell: changed',
        '',
        '- shell JS (ota, android): 3 modules differ',
        '',
        'Sources that differ inside the changed bundles:',
        '- `changed: mobile/src/a.ts`',
        '- `added: mobile/node_modules/@scope/pkg/ (2 files)`',
        ''
      ].join('\n')
    )
  })

  it('says so when a bundle moved but no source module did', () => {
    const verdict = compareShellFingerprints(
      record(),
      record({ otaAndroid: bundle('j-oa2', { 'mobile/src/a.ts': '1' }) })
    )
    expect(renderShellVerdictMarkdown(verdict)).toContain(
      '- shell JS (ota, android): bundle only, no source module differs'
    )
  })

  it('names native inputs in plain words and states the missing iOS anchor', () => {
    const head = record({ nativeAndroid: 'n-a2' })
    head.native.android.sources = [
      { type: 'contents', id: 'expoConfig', hash: 'c2' },
      { type: 'dir', id: 'modules/orca-mobile-web-shell/android', hash: 'd1' },
      {
        type: 'dir',
        id: 'node_modules/.pnpm/expo-camera@55_x/node_modules/expo-camera/android',
        hash: 'd2'
      }
    ]
    const markdown = renderShellVerdictMarkdown(
      compareShellFingerprints(record(), head),
      'mobile-android-v0.0.50'
    )
    expect(markdown).toBe(
      [
        '### Mobile release needed since mobile-android-v0.0.50: yes',
        '',
        '- native (android): app config, native module orca-mobile-web-shell (local), native module expo-camera',
        '',
        'No iOS release anchor: iOS parts are compared with this Android release commit.',
        ''
      ].join('\n')
    )
  })

  it('agrees the module count with its verb', () => {
    expect(describePart({ kind: 'shellJs', variant: 'ota', platform: 'ios', modules: 1 })).toBe(
      'shell JS (ota, ios): 1 module differs'
    )
  })

  it('caps named native inputs', () => {
    const inputs = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(describePart({ kind: 'native', platform: 'ios', inputs })).toBe(
      'native (ios): a, b, c, d, e, +2 more'
    )
  })

  it('answers unknown instead of a verdict for unreadable or mismatched records', () => {
    expect(compareShellFingerprints(null, record()).changed).toBeNull()
    expect(renderShellVerdictMarkdown(compareShellFingerprints(record(), { format: 0 }))).toBe(
      '### Mobile shell: verdict unknown — fingerprint format differs\n'
    )
  })

  it('caps the explaining list at 40 lines', () => {
    const changed = Array.from({ length: 45 }, (_, index) => `mobile/src/f${index}.ts`)
    const lines = renderShellVerdictMarkdown({
      changed: true,
      reason: null,
      parts: [{ kind: 'shellJs', variant: 'native', platform: 'ios', modules: 45 }],
      files: { added: [], removed: [], changed }
    }).split('\n')
    expect(lines.filter((line) => line.startsWith('- `'))).toHaveLength(40)
    expect(lines).toContain('- +5 more')
  })
})

describe('nativeInputName', () => {
  it.each([
    ['package:react-native', 'react-native version'],
    ['rncoreAutolinkingConfig:ios', 'React Native autolinking config'],
    ['plugins/android-respect-rotation-lock.js', 'plugins/android-respect-rotation-lock.js'],
    ['google-services.json', 'file google-services.json']
  ])('%s reads as %s', (id, name) => {
    expect(nativeInputName(id)).toBe(name)
  })
})

describe('bundle module explainer', () => {
  it('maps Metro source paths to repo paths without the pnpm store directory', () => {
    expect(repoPathOfBundleSource('/src/app.ts')).toBe('mobile/src/app.ts')
    expect(repoPathOfBundleSource('/../src/shared/protocol-version.ts')).toBe(
      'src/shared/protocol-version.ts'
    )
    expect(
      repoPathOfBundleSource(
        '/node_modules/.pnpm/react-native@0.83.10_patch_hash=abc/node_modules/react-native/index.js'
      )
    ).toBe('mobile/node_modules/react-native/index.js')
    expect(repoPathOfBundleSource('\0polyfill:environment-variables')).toBe(
      'virtual:polyfill:environment-variables'
    )
  })

  it('digests module contents and folds two installed versions into one key', () => {
    const modules = moduleDigestsFromSourceMap(
      {
        sources: [
          '/src/a.ts',
          '/node_modules/.pnpm/pkg@1/node_modules/pkg/i.js',
          '/node_modules/.pnpm/pkg@2/node_modules/pkg/i.js'
        ],
        sourcesContent: ['a', 'one', 'two']
      },
      '/repo/mobile'
    )
    const swapped = moduleDigestsFromSourceMap(
      {
        sources: [
          '/node_modules/.pnpm/pkg@2/node_modules/pkg/i.js',
          '/node_modules/.pnpm/pkg@1/node_modules/pkg/i.js',
          '/src/a.ts'
        ],
        sourcesContent: ['two', 'one', 'a']
      },
      '/repo/mobile'
    )
    expect(Object.keys(modules)).toEqual(['mobile/node_modules/pkg/i.js', 'mobile/src/a.ts'])
    expect(swapped).toEqual(modules)
  })

  it('ignores the checkout path embedded in generated module sources', () => {
    const routeContext = (root: string) => ({
      sources: ['/app?ctx=e6a1'],
      sourcesContent: [`get() { return require("${root}/mobile/app/_layout.tsx") }`]
    })
    expect(moduleDigestsFromSourceMap(routeContext('/work/orca'), '/work/orca/mobile')).toEqual(
      moduleDigestsFromSourceMap(routeContext('/runner/tmp/base'), '/runner/tmp/base/mobile')
    )
  })

  it('collapses dependency files per package', () => {
    expect(
      explainingFiles({
        added: [],
        removed: ['mobile/node_modules/zod/a.js'],
        changed: ['src/shared/x.ts', 'mobile/node_modules/zod/b.js', 'mobile/node_modules/zod/c.js']
      })
    ).toEqual([
      'changed: src/shared/x.ts',
      'changed: mobile/node_modules/zod/ (2 files)',
      'removed: mobile/node_modules/zod/ (1 file)'
    ])
  })

  it('passes only the shell switch through to the bundle', () => {
    const env = { PATH: '/bin', EXPO_PUBLIC_MOBILE_SHELL: 'ota', EXPO_PUBLIC_OTHER: 'x' }
    expect(exportEnvironment(env, 'native')).toEqual({ PATH: '/bin' })
    expect(exportEnvironment(env, 'ota')).toEqual({ PATH: '/bin', EXPO_PUBLIC_MOBILE_SHELL: 'ota' })
  })
})

describe('native digest', () => {
  it('ignores git-ignored sources so a local prebuild dir cannot differ from CI', () => {
    const tracked = [nativeSourceEntry({ type: 'contents', id: 'expoConfig', hash: 'c1' })]
    const withPrebuild = [
      nativeSourceEntry({
        type: 'dir',
        filePath: 'android',
        reasons: ['bareNativeDir'],
        hash: null
      }),
      ...tracked
    ]
    expect(nativeSourcesDigest(withPrebuild)).toBe(nativeSourcesDigest(tracked))
    expect(nativeSourcesDigest(tracked)).not.toBe(
      nativeSourcesDigest([{ type: 'contents', id: 'expoConfig', hash: 'c2' }])
    )
  })
})

// The workflow's Report step runs with `if: always()`, so a failed compute reaches `compare` as a
// missing or unreadable record file.
describe('compare command', () => {
  const script = join(import.meta.dirname, 'mobile-shell-fingerprint.mjs')

  function runCompare(files: string[], extra: string[] = []) {
    return spawnSync(process.execPath, [script, 'compare', ...files, ...extra], {
      encoding: 'utf8'
    })
  }

  it.each([
    ['missing', (dir: string) => join(dir, 'absent.json')],
    [
      'unreadable',
      (dir: string) => {
        const file = join(dir, 'truncated.json')
        writeFileSync(file, '{"format":1,"nat')
        return file
      }
    ]
  ])('answers unknown, exit 0, when a record is %s', (_label, makeBase) => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-fingerprint-test-'))
    try {
      const head = join(dir, 'head.json')
      writeFileSync(head, JSON.stringify(record()))
      const files = [makeBase(dir), head]
      const markdown = runCompare(files)
      expect(markdown.status).toBe(0)
      expect(markdown.stdout).toBe(
        '### Mobile shell: verdict unknown — a fingerprint record is missing or unreadable\n'
      )
      const json = runCompare(files, ['--json'])
      expect(json.status).toBe(0)
      expect(JSON.parse(json.stdout).changed).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers unknown, exit 0, when native sources are null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-fingerprint-test-'))
    try {
      const base = join(dir, 'base.json')
      const head = join(dir, 'head.json')
      const nulled = record()
      writeFileSync(
        base,
        JSON.stringify({
          ...nulled,
          native: { ...nulled.native, ios: { hash: 'n-i', sources: null } }
        })
      )
      writeFileSync(head, JSON.stringify(record()))
      const markdown = runCompare([base, head])
      expect(markdown.status).toBe(0)
      expect(markdown.stdout).toBe(
        '### Mobile shell: verdict unknown — a fingerprint record is malformed\n'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers unknown, exit 0, for a parseable record without native or shellJs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-fingerprint-test-'))
    try {
      const base = join(dir, 'base.json')
      const head = join(dir, 'head.json')
      writeFileSync(base, JSON.stringify({ format: 1, native: record().native }))
      writeFileSync(head, JSON.stringify(record()))
      const markdown = runCompare([base, head])
      expect(markdown.status).toBe(0)
      expect(markdown.stdout).toBe(
        '### Mobile shell: verdict unknown — a fingerprint record is malformed\n'
      )
      expect(JSON.parse(runCompare([head, base], ['--json']).stdout).changed).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
