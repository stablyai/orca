import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assessProcessHostImports,
  collectProcessHostSources,
  main,
  readProcessHostBaseline
} from './check-process-host-imports.mjs'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'

const PACKAGE_SOURCE = 'src/packages/process-host/src/'
const manifest = {
  exports: { '.': './src/run-process.ts', './fork-process': './src/fork-process.ts' },
  devDependencies: { vitest: '*' }
}
const roots = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function assess(files, baseline = [], packageManifest = manifest) {
  return assessProcessHostImports(new Map(Object.entries(files)), packageManifest, baseline)
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-process-host-imports-'))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  return root
}

describe('process-host import boundary', () => {
  it('reads actual imports and reexports while ignoring comments and embedded programs', () => {
    expect(
      collectModuleSpecifiers(
        'file.ts',
        `
          // import { spawn } from 'node:child_process'
          const script = "require('node:child_process')"
          import type { ProcessSpec } from '@orca/process-host/process-spec'
          export { forkProcess } from '@orca/process-host/fork-process'
          type Child = import('child_process').ChildProcess
          import legacy = require('legacy-package')
          import('dynamic-package')
          require('required-package')
          require.resolve('resolved-package')
        `
      )
    ).toEqual([
      '@orca/process-host/process-spec',
      '@orca/process-host/fork-process',
      'child_process',
      'legacy-package',
      'dynamic-package',
      'required-package',
      'resolved-package'
    ])
  })

  it('fails closed on source it cannot parse', () => {
    expect(() => collectModuleSpecifiers('broken.ts', 'import {')).toThrow('Cannot parse broken.ts')
  })

  it('allows Node implementation imports and public consumer entry points', () => {
    expect(
      assess({
        [`${PACKAGE_SOURCE}run-process.ts`]: "import { spawn } from 'node:child_process'",
        [`${PACKAGE_SOURCE}run-process.test.ts`]: "import { it } from 'vitest'",
        'src/main/consumer.ts': "import { spawnProcess } from '@orca/process-host'",
        'config/scripts/consumer.mjs':
          "import { forkProcess } from '@orca/process-host/fork-process'"
      })
    ).toEqual({ direct: [], added: [], stale: [], violations: [] })
  })

  it.each([
    ['src/main/consumer.ts', '../packages/process-host'],
    ['src/main/consumer.ts', '../packages/process-host/src/run-process'],
    ['src/main/consumer.test.ts', '../packages/process-host/src/run-process'],
    ['config/scripts/consumer.mjs', '../../src/packages/process-host/src/run-process'],
    ['tests/e2e/consumer.ts', '../../src/packages/process-host/src/run-process'],
    ['mobile/src/consumer.ts', '../../src/packages/process-host/src/run-process'],
    ['src/main/consumer.ts', '@orca/process-host/src/run-process'],
    ['src/main/consumer.ts', '@orca/process-host/private-process-state']
  ])('rejects private package access in %s', (file, specifier) => {
    expect(assess({ [file]: `import '${specifier}'` }).violations).toHaveLength(1)
  })

  it.each([
    ['src/main/consumer.ts', '..\\packages\\process-host'],
    ['src/main/consumer.ts', '..\\packages\\process-host\\src\\run-process'],
    ['src/main/consumer.ts', '..\\packages\\process-host\\dist\\run-process.js'],
    ['config/scripts/consumer.mjs', '..\\..\\src\\packages\\process-host\\src\\run-process'],
    ['src/main/consumer.ts', '@orca\\process-host\\src\\run-process'],
    ['src/main/consumer.ts', '@orca/process-host\\private-process-state']
  ])('rejects Windows private package access in %s through %s', (file, specifier) => {
    expect(assess({ [file]: `require(${JSON.stringify(specifier)})` }).violations).toHaveLength(1)
  })

  it('shares fixture corpora only with test-only importers, keeping implementation imports public', () => {
    const corpus = '../packages/process-host/src/__fixtures__/windows-argument-corpus'
    expect(assess({ 'src/main/consumer.test.ts': `import '${corpus}'` }).violations).toEqual([])
    expect(assess({ 'src/main/consumer.ts': `import '${corpus}'` }).violations).toHaveLength(1)
    expect(
      assess({
        'src/main/consumer.test.ts':
          "import '../packages/process-host/src/__fixtures__/../run-process'"
      }).violations
    ).toHaveLength(1)
  })

  it.each([
    ['../main/runtime', 'cannot import outside'],
    ['../../../main/runtime', 'cannot import outside'],
    ['/repo/src/main/runtime.ts', 'absolute path'],
    ['@renderer/store', 'undeclared'],
    ['@/store', 'undeclared'],
    ['electron', 'undeclared'],
    ['vitest', 'undeclared'],
    ['undeclared-package/subpath', 'undeclared']
  ])('rejects package dependence on %s', (specifier, reason) => {
    expect(
      assess({ [`${PACKAGE_SOURCE}runner.ts`]: `import '${specifier}'` }).violations[0]
    ).toContain(reason)
  })

  it.each([
    ['..\\..\\..\\main\\runtime', 'cannot import outside'],
    ['.\\..\\..\\..\\main\\runtime', 'cannot import outside'],
    ['C:\\repo\\src\\main\\runtime.ts', 'absolute path'],
    ['\\\\server\\repo\\src\\main\\runtime.ts', 'absolute path'],
    ['@renderer\\store', 'undeclared']
  ])('rejects package dependence on Windows specifier %s', (specifier, reason) => {
    expect(
      assess({ [`${PACKAGE_SOURCE}runner.ts`]: `require(${JSON.stringify(specifier)})` })
        .violations[0]
    ).toContain(reason)
  })

  it('permits Windows relative imports within package source and test fixture corpora', () => {
    const corpus = '..\\packages\\process-host\\src\\__fixtures__\\windows-argument-corpus'
    const traversal = '..\\packages\\process-host\\src\\__fixtures__\\..\\run-process'
    expect(
      assess({
        [`${PACKAGE_SOURCE}runner.ts`]: `require(${JSON.stringify('.\\process-spec')})`,
        'src/main/consumer.test.ts': `require(${JSON.stringify(corpus)})`
      }).violations
    ).toEqual([])
    expect(
      assess({
        'src/main/consumer.test.ts': `require(${JSON.stringify(traversal)})`
      }).violations
    ).toHaveLength(1)
  })

  it('allows only declared runtime dependencies in production package source', () => {
    expect(
      assess(
        { [`${PACKAGE_SOURCE}runner.ts`]: "import 'declared/subpath'; import './process-spec'" },
        [],
        { ...manifest, dependencies: { declared: '*' } }
      ).violations
    ).toEqual([])
  })

  it('reports new and removed legacy direct importers without exempting type imports', () => {
    expect(
      assess(
        {
          'src/main/legacy.ts': "import { spawn } from 'node:child_process'",
          'src/relay/new.ts': "import type { ChildProcess } from 'child_process'",
          'src/main/consumer.test.ts': "import { spawn } from 'node:child_process'",
          'config/scripts/build.mjs': "import { spawn } from 'node:child_process'"
        },
        ['src/main/legacy.ts', 'src/main/removed.ts']
      )
    ).toEqual({
      direct: ['src/main/legacy.ts', 'src/relay/new.ts'],
      added: ['src/relay/new.ts'],
      stale: ['src/main/removed.ts'],
      violations: []
    })
  })

  it('scans nested package, consumer, test, config, and mobile source without generated checkouts', () => {
    const files = [
      `${PACKAGE_SOURCE}nested/runner.ts`,
      'src/main/consumer.ts',
      'electron.vite.config.ts',
      'config/build-plugins/consumer.ts',
      'config/scripts/nested/build.mjs',
      'tests/e2e/consumer.ts',
      'mobile/src/consumer.ts',
      'mobile/app/consumer.tsx',
      'mobile/scripts/consumer.mts'
    ]
    const ignored = [
      'tests/e2e/.cross-version-checkouts/src/runtime.ts',
      'src/packages/process-host/node_modules/dep/index.js'
    ]
    const root = fixture(
      Object.fromEntries([...files, ...ignored].map((file) => [file, 'export {}']))
    )
    expect([...collectProcessHostSources(root).keys()]).toEqual(files.sort())
  })

  it('checks the command-line path against the source tree and baseline', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const files = {
      'src/packages/process-host/package.json': JSON.stringify(manifest),
      'config/process-host-direct-import-baseline.txt': 'src/main/legacy.ts\n',
      [`${PACKAGE_SOURCE}runner.ts`]: "import { spawn } from 'node:child_process'",
      'src/main/legacy.ts': "import { spawn } from 'node:child_process'"
    }
    expect(main(fixture(files))).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 legacy direct importers remain'))
    expect(
      main(fixture({ ...files, 'src/main/new.ts': "import { spawn } from 'node:child_process'" }))
    ).toBe(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('src/main/new.ts: new direct child_process import')
    )
  })

  it('fails loudly when the package implementation disappears', () => {
    const root = fixture({
      'src/packages/process-host/package.json': JSON.stringify(manifest),
      'config/process-host-direct-import-baseline.txt': ''
    })
    expect(() => main(root)).toThrow('Missing process-host implementation')
  })

  it('reads a commented baseline without allowing formatting to invent entries', () => {
    expect(readProcessHostBaseline('# migration debt\n\n src/main/legacy.ts \n')).toEqual([
      'src/main/legacy.ts'
    ])
  })
})
