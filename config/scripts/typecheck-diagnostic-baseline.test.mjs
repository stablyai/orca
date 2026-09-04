import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const script = join(repoRoot, 'config/scripts/typecheck-diagnostic-baseline.mjs')
const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc')
let fixtureDir

afterEach(() => {
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
  fixtureDir = undefined
})

function createFixture(source) {
  fixtureDir = mkdtempSync(join(tmpdir(), 'orca-typecheck-baseline-'))
  writeFileSync(
    join(fixtureDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['source.ts'] })
  )
  writeFileSync(join(fixtureDir, 'source.ts'), source)
  return {
    baseline: join(fixtureDir, 'baseline.json'),
    baseBaseline: join(fixtureDir, 'base-baseline.json'),
    project: join(fixtureDir, 'tsconfig.json'),
    source: join(fixtureDir, 'source.ts')
  }
}

function runBaseline(paths, extraArgs = [], spawnOptions = {}) {
  return spawnSync(
    process.execPath,
    [
      ...(spawnOptions.nodeArgs ?? []),
      spawnOptions.script ?? script,
      '--project',
      paths.project,
      '--baseline',
      paths.baseline,
      '--tsc',
      paths.tsc ?? tsc,
      ...extraArgs
    ],
    {
      cwd: spawnOptions.cwd ?? repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...spawnOptions.env }
    }
  )
}

describe('typecheck diagnostic baseline', () => {
  it('loads PR-base baselines in desktop and mobile CI', () => {
    const desktopWorkflow = readFileSync(join(repoRoot, '.github/workflows/pr.yml'), 'utf8')
    const mobileWorkflow = readFileSync(join(repoRoot, '.github/workflows/mobile.yml'), 'utf8')

    expect(desktopWorkflow).toContain('$BASE_SHA:config/typecheck-e2e-diagnostics.json')
    expect(mobileWorkflow).toContain('$BASE_SHA:mobile/typecheck-test-diagnostics.json')
    expect(desktopWorkflow).toContain('TYPECHECK_BASELINE_BASE_PATH=')
    expect(mobileWorkflow).toContain('TYPECHECK_BASELINE_BASE_PATH=')
  })

  it('requires recorded diagnostics to remain present', () => {
    const paths = createFixture("const value: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)
    expect(JSON.parse(readFileSync(paths.baseline, 'utf8')).diagnostics).toHaveLength(1)
    expect(runBaseline(paths).status).toBe(0)

    writeFileSync(paths.source, 'const value: number = 1\n')
    const stale = runBaseline(paths)
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain('Stale allowlist entries (1)')
  })

  it('rejects a diagnostic added after a clean baseline', () => {
    const paths = createFixture('const value: number = 1\n')
    expect(runBaseline(paths, ['--write']).status).toBe(0)

    writeFileSync(paths.source, "const value: number = 'bad'\n")
    const unexpected = runBaseline(paths)
    expect(unexpected.status).toBe(1)
    expect(unexpected.stderr).toContain('Unexpected diagnostics (1)')
  })

  it('rejects another occurrence of an allowlisted diagnostic', () => {
    const paths = createFixture("const first: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)

    writeFileSync(paths.source, "const first: number = 'bad'\nconst second: number = 'also-bad'\n")
    const unexpected = runBaseline(paths)
    expect(unexpected.status).toBe(1)
    expect(unexpected.stderr).toContain('Unexpected diagnostics (1)')
  })

  it('does not drift when only diagnostic positions move', () => {
    const paths = createFixture("const value: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)

    writeFileSync(paths.source, "\nconst value: number = 'bad'\n")
    expect(runBaseline(paths).status).toBe(0)
  })

  it('matches recorded diagnostics through a symlinked checkout path', () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'orca-typecheck-symlink-'))
    const linkedCheckout = join(fixtureDir, 'checkout')
    symlinkSync(repoRoot, linkedCheckout, process.platform === 'win32' ? 'junction' : 'dir')

    const result = runBaseline(
      {
        project: 'config/tsconfig.e2e.json',
        baseline: 'config/typecheck-e2e-diagnostics.json'
      },
      [],
      {
        nodeArgs: ['--preserve-symlinks-main'],
        script: join(linkedCheckout, 'config/scripts/typecheck-diagnostic-baseline.mjs')
      }
    )

    // Derived, not hardcoded: the backlog shrinks by design, and a literal count
    // would make the ratchet working as intended fail this test.
    const recorded = JSON.parse(
      readFileSync(join(repoRoot, 'config/typecheck-e2e-diagnostics.json'), 'utf8')
    ).diagnostics.length

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`${recorded} known diagnostics, no drift`)
  })

  it('ignores stderr warnings while parsing compiler diagnostics', () => {
    const paths = createFixture("const value: number = 'bad'\n")
    paths.tsc = join(fixtureDir, 'fake-tsc.mjs')
    writeFileSync(
      paths.tsc,
      [
        "if (process.env.INJECT_TSC_WARNING) process.stderr.write('pnpm warning: unsupported engine\\n')",
        "process.stdout.write(\"source.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\\n\")",
        'process.exitCode = 1'
      ].join('\n')
    )
    expect(runBaseline(paths, ['--write']).status).toBe(0)

    const result = runBaseline(paths, [], { env: { INJECT_TSC_WARNING: '1' } })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 known diagnostics, no drift')
  })

  it('rejects a committed baseline that grew from the PR base', () => {
    const paths = createFixture("const first: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)
    // Base knows only the first error; the committed baseline was raised to cover a second.
    const base = JSON.parse(readFileSync(paths.baseline, 'utf8'))
    writeFileSync(paths.baseBaseline, JSON.stringify(base))
    writeFileSync(paths.source, "const first: number = 'bad'\nconst second: boolean = 'also-bad'\n")
    expect(runBaseline(paths, ['--write', '--base-baseline', paths.baseBaseline]).status).toBe(1)
    writeFileSync(
      paths.baseline,
      JSON.stringify({
        version: 1,
        diagnostics: [
          ...base.diagnostics,
          {
            file: 'source.ts',
            line: 2,
            column: 7,
            code: 2322,
            message: "Type 'string' is not assignable to type 'boolean'."
          }
        ]
      })
    )

    const check = runBaseline(paths, ['--base-baseline', paths.baseBaseline])

    expect(check.status).toBe(1)
    expect(check.stderr).toContain('Diagnostic baseline grew (1)')
  })

  it('reads the PR base from the environment the way CI passes it', () => {
    const paths = createFixture("const value: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)
    writeFileSync(paths.baseBaseline, JSON.stringify({ version: 1, diagnostics: [] }))

    const result = runBaseline(paths, [], {
      env: { TYPECHECK_BASELINE_BASE_PATH: paths.baseBaseline }
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Diagnostic baseline grew (1)')
  })

  it('resolves the env-supplied PR base against the repo, not the working directory', () => {
    // Mobile CI runs this with working-directory: mobile, so a repo-relative base
    // path must not resolve against the caller's cwd.
    const result = runBaseline(
      {
        project: 'config/tsconfig.e2e.json',
        baseline: 'config/typecheck-e2e-diagnostics.json'
      },
      [],
      {
        cwd: join(repoRoot, 'mobile'),
        env: { TYPECHECK_BASELINE_BASE_PATH: 'config/typecheck-e2e-diagnostics.json' }
      }
    )

    expect(result.stderr).not.toContain('ENOENT')
    expect(result.status).toBe(0)
  })

  it('names the regeneration command when the baseline drifts', () => {
    const paths = createFixture("const value: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)
    writeFileSync(paths.source, 'const value: number = 1\n')

    const stale = runBaseline(paths)

    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain('config/scripts/typecheck-diagnostic-baseline.mjs')
    expect(stale.stderr).toContain('--write')
  })

  it('names a command runnable from the directory that printed it', () => {
    // Mobile runs its typecheck from mobile/, where a repo-relative path is not runnable.
    const paths = createFixture("const value: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)
    writeFileSync(paths.source, 'const value: number = 1\n')

    const stale = runBaseline(paths, [], { cwd: join(repoRoot, 'mobile') })

    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain('node ../config/scripts/typecheck-diagnostic-baseline.mjs')
  })

  it('refuses to regenerate a baseline that grows from the PR base', () => {
    const paths = createFixture("const first: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)
    writeFileSync(paths.baseBaseline, readFileSync(paths.baseline, 'utf8'))

    writeFileSync(paths.source, "const first: number = 'bad'\nconst second: boolean = 'also-bad'\n")
    const growth = runBaseline(paths, ['--write', '--base-baseline', paths.baseBaseline])
    expect(growth.status).toBe(1)
    expect(growth.stderr).toContain('Diagnostic baseline grew (1)')
    expect(JSON.parse(readFileSync(paths.baseline, 'utf8')).diagnostics).toHaveLength(1)
  })
})
