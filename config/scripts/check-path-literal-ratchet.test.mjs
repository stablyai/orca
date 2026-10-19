import { describe, expect, it } from 'vitest'

import {
  createPathResolver,
  extractPathLiterals,
  isScannedPath,
  liveGateReferences,
  stripSlashComments
} from './check-path-literal-ratchet.mjs'

describe('extractPathLiterals', () => {
  it('reads quoted literals, relative imports and pathspec globs in code', () => {
    const text = [
      "const a = 'src/main/ssh/ssh-connection.ts'",
      "import { b } from '../../src/shared/protocol-version'",
      "await import('./src/main/ssh/relay.ts')",
      "git diff -- ':(glob)src/shared/windows-*'",
      '// src/main/ipc/pty.ts is prose, not a reference',
      "/** Moved from 'src/main/ipc/worktrees.ts' in #123. */",
      "const glob = 'src/renderer/**/*.tsx'",
      "const deep = 'src/main/**/ssh-connection.ts'"
    ].join('\n')
    expect(extractPathLiterals('config/scripts/route.mjs', text)).toEqual([
      { literal: 'src/main/ssh/ssh-connection.ts', isImport: false },
      { literal: 'src/shared/protocol-version', isImport: true },
      { literal: 'src/main/ssh/relay.ts', isImport: true },
      { literal: 'src/shared/windows-', isImport: false },
      { literal: 'src/renderer/', isImport: false },
      { literal: 'src/main/', isImport: false }
    ])
    expect(extractPathLiterals('.github/workflows/x.yml', "# was 'src/main/a.ts'\n")).toEqual([])
  })

  it('resolves a literal exactly when any occurrence is an import', () => {
    const text = "import '../../src/main/ssh/ssh-types'\nconst route = 'src/main/ssh/ssh-types'"
    expect(extractPathLiterals('tests/e2e/a.spec.ts', text)).toEqual([
      { literal: 'src/main/ssh/ssh-types', isImport: true }
    ])
  })

  it('reads a relative glob as a prefix, not an import', () => {
    expect(extractPathLiterals('config/tsconfig.x.json', '"../src/main/ssh/ssh-*.ts"')).toEqual([
      { literal: 'src/main/ssh/ssh-', isImport: false }
    ])
    expect(extractPathLiterals('config/x.mjs', "new URL('../../src/main/acp/generated/')")).toEqual(
      [{ literal: 'src/main/acp/generated/', isImport: false }]
    )
  })

  it('reads unquoted command arguments in manifests and workflows', () => {
    const text = '"command": "pnpm test src/main/a.test.ts src/renderer/src/b.test.ts"'
    expect(extractPathLiterals('config/reliability-gates.jsonc', text)).toEqual([
      { literal: 'src/main/a.test.ts', isImport: false },
      { literal: 'src/renderer/src/b.test.ts', isImport: false }
    ])
    expect(extractPathLiterals('.github/workflows/x.yml', "  - 'src/main/ssh/**'\n")).toEqual([
      { literal: 'src/main/ssh/', isImport: false }
    ])
  })

  it('ignores paths outside the app source roots', () => {
    expect(
      extractPathLiterals('config/x.mjs', "'src/lib/downloadTargets.ts' 'mobile/src/a.ts'")
    ).toEqual([])
  })
})

describe('stripSlashComments', () => {
  it('keeps comment markers inside strings and drops real comments', () => {
    const text = [
      "const a = 'src/main/**/*.ts'",
      "const b = 'src/main/removed.ts' // was 'src/main/old.ts'",
      "/** see 'src/main/doc.ts' */ const url = 'https://x.test/a'"
    ].join('\n')
    expect(stripSlashComments(text)).toBe(
      [
        "const a = 'src/main/**/*.ts'",
        "const b = 'src/main/removed.ts' ",
        "  const url = 'https://x.test/a'"
      ].join('\n')
    )
  })
})

describe('isScannedPath', () => {
  it('skips unit tests, fixtures and generated timings, but scans e2e specs', () => {
    expect(isScannedPath('config/scripts/pr-e2e-source-routing.mjs')).toBe(true)
    expect(isScannedPath('.github/workflows/pr.yml')).toBe(true)
    expect(isScannedPath('tests/e2e/ssh-orcad-terminal-journeys.spec.ts')).toBe(true)
    expect(isScannedPath('config/scripts/pr-e2e-source-routing.test.mjs')).toBe(false)
    expect(isScannedPath('tests/e2e/helpers/pr-comments-sidebar-fixture.ts')).toBe(false)
    expect(isScannedPath('config/scripts/ci-shard-timings.json')).toBe(false)
    expect(isScannedPath('config/patches/foo.patch')).toBe(false)
  })
})

describe('createPathResolver', () => {
  const resolves = createPathResolver([
    'src/main/ssh/ssh-connection.ts',
    'src/main/ssh/ssh-types.test.ts'
  ])

  it('accepts a file, an extensionless import, a folder and a prefix', () => {
    expect(resolves('src/main/ssh/ssh-connection.ts')).toBe(true)
    expect(resolves('src/main/ssh/ssh-connection')).toBe(true)
    expect(resolves('src/main/ssh/')).toBe(true)
    expect(resolves('src/main/ssh/ssh-')).toBe(true)
  })

  it('flags a literal whose file moved', () => {
    expect(resolves('src/main/ssh/connection/ssh-connection.ts')).toBe(false)
    expect(resolves('src/main/managed-server/')).toBe(false)
  })

  it('resolves an import exactly, so a same-prefix sibling cannot hide a moved module', () => {
    expect(resolves('src/main/ssh/ssh-connection', true)).toBe(true)
    expect(resolves('src/main/ssh/ssh-types', true)).toBe(false)
    expect(resolves('src/main/ssh/ssh-types')).toBe(true)
  })

  it('needs an index module to resolve an import of a folder', () => {
    expect(resolves('src/main/ssh', true)).toBe(false)
    expect(resolves('src/main/ssh')).toBe(true)
  })
})

describe('liveGateReferences', () => {
  it('reads every gate command and test file, never evidence prose or evidence runs', () => {
    const manifest = `{
      // a comment
      "gates": [{
        "commands": ["vitest run src/main/kept.test.ts"],
        "testFiles": ["src/main/listed.test.ts"],
        "evidence": "once ran src/main/prose.test.ts",
        "evidenceRuns": [{
          "command": "vitest run src/main/ran-then.test.ts",
          "currentCommand": "vitest run src/main/kept.test.ts"
        }]
      }]
    }`
    const literals = extractPathLiterals(
      'config/reliability-gates.jsonc',
      liveGateReferences(manifest)
    ).map(({ literal }) => literal)
    expect(literals).toEqual(['src/main/kept.test.ts', 'src/main/listed.test.ts'])
  })
})
