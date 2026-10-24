import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runProcessSync } from '@orca/process-host'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from './check-react-doctor-changed.mjs'
import { collectAddedLineRanges } from './check-changed-code-quality.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const script = path.join(repoRoot, 'config', 'scripts', 'check-react-doctor-changed.mjs')

function runWithBase(base) {
  return spawnSync(process.execPath, [script, base], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true
  })
}

describe('check-react-doctor-changed diff base', () => {
  // Invalid bases must fail before installing or running a tool.
  it.each(['main & calc', 'main | whoami', 'main"x', '%PATH%', 'main $(id)', '--help'])(
    'refuses %j',
    (base) => {
      const result = runWithBase(base)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Refusing to pass an unsafe diff base')
    }
  )
})

const temporaryRoots = []
const source = [
  "import { useState } from 'react'",
  '',
  'export function Counter() {',
  '  const [count, setCount] = useState(0)',
  '  function change() {',
  '    setCount((current) => {',
  "      localStorage.setItem('count', String(current))",
  '      return current + 1',
  '    })',
  '  }',
  '  return <button onClick={change}>{count}</button>',
  '}',
  ''
].join('\n')

function git(root, ...args) {
  const result = runProcessSync({
    program: 'git',
    args,
    cwd: root,
    timeoutMs: null,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-react-doctor-gate-'))
  temporaryRoots.push(root)
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  const hooks = path.join(root, '.git', 'test-hooks')
  mkdirSync(hooks)
  git(root, 'config', 'core.hooksPath', hooks)
  writeFileSync(path.join(root, 'Counter.tsx'), source)
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'base')
  return { root, base: git(root, 'rev-parse', 'HEAD') }
}

function report(root, base, file, line = 6, endLine = 9, reportRoot = root) {
  const relative = path.relative(reportRoot, path.resolve(root, file)).split(path.sep).join('/')
  const message = 'State updater has side effects'
  const digest = createHash('sha256')
    .update(JSON.stringify(['error', message]))
    .digest('hex')
  const diagnostic = {
    filePath: file,
    normalizedFilePath: file,
    line,
    column: 5,
    endLine,
    severity: 'error',
    plugin: 'react-doctor',
    rule: 'no-impure-state-updater',
    message,
    id: `${relative}::${line}:5::react-doctor/no-impure-state-updater::${digest}`,
    help: 'Keep state updaters pure',
    category: 'Bugs',
    tags: []
  }
  return {
    schemaVersion: 3,
    version: '0.9.14',
    mode: 'diff',
    ok: true,
    error: null,
    directory: reportRoot,
    elapsedMilliseconds: 0,
    diff: {
      baseBranch: base,
      currentBranch: 'fixture',
      changedFileCount: 1,
      isCurrentChanges: false
    },
    diagnostics: [diagnostic],
    summary: {
      errorCount: 1,
      warningCount: 0,
      totalDiagnosticCount: 1,
      affectedFileCount: 1,
      score: null,
      scoreLabel: null
    },
    projects: [
      {
        directory: root,
        packageRoot: root,
        framework: 'vite',
        project: {},
        score: null,
        complete: true,
        skippedChecks: [],
        diagnostics: [diagnostic],
        analyzedFiles: [file],
        analyzedFileCount: 1,
        scannedFileCount: 1,
        elapsedMilliseconds: 0
      }
    ]
  }
}

function replaceProjectDiagnostic(value, changes) {
  const diagnostic = { ...value.diagnostics[0], ...changes }
  const digest = createHash('sha256')
    .update(JSON.stringify([diagnostic.severity, diagnostic.message]))
    .digest('hex')
  diagnostic.id = `${diagnostic.id.slice(0, diagnostic.id.lastIndexOf('::'))}::${digest}`
  return { ...value, projects: [{ ...value.projects[0], diagnostics: [diagnostic] }] }
}

function runReport(root, base, value, overrides = {}) {
  return main(root, base, () => ({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify(value),
    stderr: '',
    ...overrides
  }))
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('React Doctor rename-aware changed-line gate', () => {
  it('does not treat an unchanged renamed updater as added when an import changes', () => {
    const { root, base } = createRepository()
    mkdirSync(path.join(root, 'nested folder'))
    const file = 'nested folder/Moved Counter.tsx'
    renameSync(path.join(root, 'Counter.tsx'), path.join(root, file))
    writeFileSync(path.join(root, file), source.replace("from 'react'", "from 'react-compatible'"))
    git(root, 'add', '.')

    expect(collectAddedLineRanges(root, base).rangesByFile.get(file)).toEqual([
      { start: 1, end: 1 }
    ])
    expect(runReport(root, base, report(root, base, file))).toBe(0)
  })

  it('blocks a new side effect inside an existing renamed updater span', () => {
    const { root, base } = createRepository()
    const file = 'MovedCounter.tsx'
    renameSync(path.join(root, 'Counter.tsx'), path.join(root, file))
    writeFileSync(
      path.join(root, file),
      source.replace(
        '      return current + 1',
        "      localStorage.setItem('new', 'effect')\n      return current + 1"
      )
    )
    git(root, 'add', '.')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, report(root, base, file, 6, 10))).toBe(1)
  })

  it('blocks a copied violation while retaining the old file', () => {
    const { root, base } = createRepository()
    writeFileSync(
      path.join(root, 'CopiedCounter.tsx'),
      readFileSync(path.join(root, 'Counter.tsx'))
    )
    git(root, 'add', '.')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, report(root, base, 'CopiedCounter.tsx'))).toBe(1)
  })

  it('blocks a new untracked file containing a violation', () => {
    const { root, base } = createRepository()
    writeFileSync(path.join(root, 'NewCounter.tsx'), source)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, report(root, base, 'NewCounter.tsx'))).toBe(1)
  })

  it.each([
    'cloud/Counter.tsx',
    'page.html',
    'page.HTML',
    'page.astro',
    'module.mts',
    'module.mjs'
  ])('retains React Doctor coverage for %s', (file) => {
    const { root, base } = createRepository()
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), source)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, report(root, base, file))).toBe(1)
  })

  it('resolves nested project diagnostics relative to their concrete package root', () => {
    const { root, base } = createRepository()
    mkdirSync(path.join(root, 'mobile'))
    writeFileSync(path.join(root, 'mobile/Counter.tsx'), source)
    const value = report(path.join(root, 'mobile'), base, 'Counter.tsx', 6, 9, root)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runReport(root, base, value)).toBe(1)
  })

  it('accepts a complete empty report for intentionally ignored source', () => {
    const { root, base } = createRepository()
    const value = report(root, base, 'Counter.tsx')
    value.projects = []
    value.diagnostics = []
    value.summary = {
      ...value.summary,
      errorCount: 0,
      affectedFileCount: 0,
      totalDiagnosticCount: 0
    }

    expect(runReport(root, base, value)).toBe(0)
  })

  it.each([
    ['inconsistent diagnostics', (value) => ({ ...value, diagnostics: [] }), {}],
    ['malformed JSON', (value) => value, { stdout: '{' }],
    ['unsupported schema', (value) => ({ ...value, schemaVersion: 1 }), {}],
    ['failed report', (value) => ({ ...value, ok: false }), {}],
    ['missing diagnostics', (value) => ({ ...value, diagnostics: undefined }), {}],
    ['missing diff', (value) => ({ ...value, diff: undefined }), {}],
    ['missing summary', (value) => ({ ...value, summary: undefined }), {}],
    ['wrong base', (value) => ({ ...value, diff: { ...value.diff, baseBranch: 'HEAD' } }), {}],
    ['wrong report root', (value) => ({ ...value, directory: path.dirname(value.directory) }), {}],
    [
      'invalid changed-file count',
      (value) => ({ ...value, diff: { ...value.diff, changedFileCount: -1 } }),
      {}
    ],
    [
      'coverage exceeding changed files',
      (value) => ({ ...value, diff: { ...value.diff, changedFileCount: 0 } }),
      {}
    ],
    [
      'incorrect summary count',
      (value) => ({ ...value, summary: { ...value.summary, errorCount: 0 } }),
      {}
    ],
    [
      'incorrect affected-file count',
      (value) => ({ ...value, summary: { ...value.summary, affectedFileCount: 0 } }),
      {}
    ],
    [
      'missing analyzed paths',
      (value) => ({ ...value, projects: [{ ...value.projects[0], analyzedFiles: undefined }] }),
      {}
    ],
    [
      'missing analyzed count',
      (value) => ({ ...value, projects: [{ ...value.projects[0], analyzedFileCount: undefined }] }),
      {}
    ],
    [
      'missing scanned count',
      (value) => ({ ...value, projects: [{ ...value.projects[0], scannedFileCount: undefined }] }),
      {}
    ],
    [
      'incorrect analyzed count',
      (value) => ({ ...value, projects: [{ ...value.projects[0], analyzedFileCount: 2 }] }),
      {}
    ],
    [
      'incorrect scanned count',
      (value) => ({ ...value, projects: [{ ...value.projects[0], scannedFileCount: 2 }] }),
      {}
    ],
    [
      'duplicate analyzed paths',
      (value) => ({
        ...value,
        diff: { ...value.diff, changedFileCount: 2 },
        projects: [
          {
            ...value.projects[0],
            analyzedFiles: ['Counter.tsx', 'Counter.tsx'],
            analyzedFileCount: 2,
            scannedFileCount: 2
          }
        ]
      }),
      {}
    ],
    [
      'diagnostic missing from declared coverage',
      (value) => ({
        ...value,
        projects: [
          { ...value.projects[0], analyzedFiles: [], analyzedFileCount: 0, scannedFileCount: 0 }
        ]
      }),
      {}
    ],
    [
      'equal-count diagnostic severity mismatch',
      (value) => replaceProjectDiagnostic(value, { severity: 'warning' }),
      {}
    ],
    [
      'equal-count diagnostic message mismatch',
      (value) => replaceProjectDiagnostic(value, { message: 'different' }),
      {}
    ],
    [
      'equal-count diagnostic annotation mismatch',
      (value) => ({
        ...value,
        projects: [
          { ...value.projects[0], diagnostics: [{ ...value.diagnostics[0], help: 'different' }] }
        ]
      }),
      {}
    ],
    [
      'inconsistent normalized path',
      (value) => ({
        ...value,
        projects: [
          {
            ...value.projects[0],
            diagnostics: [{ ...value.diagnostics[0], normalizedFilePath: 'Other.tsx' }]
          }
        ]
      }),
      {}
    ],
    [
      'inconsistent diagnostic identity',
      (value) => ({
        ...value,
        projects: [
          { ...value.projects[0], diagnostics: [{ ...value.diagnostics[0], id: 'Other.tsx' }] }
        ]
      }),
      {}
    ],
    [
      'skipped-check reason',
      (value) => ({
        ...value,
        projects: [{ ...value.projects[0], skippedCheckReasons: { 'lint:partial': 'timed out' } }]
      }),
      {}
    ],
    [
      'incomplete project',
      (value) => ({ ...value, projects: [{ ...value.projects[0], complete: false }] }),
      {}
    ],
    [
      'skipped project',
      (value) => ({ ...value, skippedProjects: [{ reason: 'max-duration' }] }),
      {}
    ],
    [
      'skipped lint',
      (value) => ({ ...value, projects: [{ ...value.projects[0], skippedChecks: ['lint'] }] }),
      {}
    ],
    ['degraded baseline', (value) => ({ ...value, baselineDegraded: true }), {}],
    [
      'invalid span',
      (value) => ({
        ...value,
        projects: [{ ...value.projects[0], diagnostics: [{ ...value.diagnostics[0], endLine: 1 }] }]
      }),
      {}
    ],
    ['crashed process', (value) => value, { code: 134 }],
    ['terminated process', (value) => value, { signal: 'SIGABRT' }],
    ['timed out process', (value) => value, { timedOut: true }],
    ['truncated output', (value) => value, { outputTruncated: true }]
  ])('fails closed on %s', (_label, change, overrides) => {
    const { root, base } = createRepository()
    expect(() =>
      runReport(root, base, change(report(root, base, 'Counter.tsx')), overrides)
    ).toThrow()
  })
})
