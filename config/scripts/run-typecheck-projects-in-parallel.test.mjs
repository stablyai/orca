import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TYPECHECK_PROJECTS,
  admissibleHeapGib,
  planTypecheckBatches,
  resolveProjectCompiler
} from './run-typecheck-projects-in-parallel.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const CI_RUNNER = { totalBytes: 16 * 1024 ** 3, parallelism: 4 }
const DEV_LAPTOP = { totalBytes: 64 * 1024 ** 3, parallelism: 18 }

function planFor({ totalBytes, parallelism }, projects = TYPECHECK_PROJECTS) {
  return planTypecheckBatches(projects, {
    budgetGib: admissibleHeapGib(totalBytes),
    parallelism
  })
}

function batchOf(batches, config) {
  return batches.findIndex((batch) => batch.some((project) => project.config === config))
}

describe('typecheck project admission', () => {
  it('keeps the two expensive projects off the same CI runner', () => {
    const batches = planFor(CI_RUNNER)
    expect(batchOf(batches, 'config/tsconfig.node.json')).not.toBe(
      batchOf(batches, 'config/tsconfig.tc.web.json')
    )
  })

  it('holds every CI batch inside the memory budget', () => {
    const budget = admissibleHeapGib(CI_RUNNER.totalBytes)
    for (const batch of planFor(CI_RUNNER)) {
      const claimed = batch.reduce((total, project) => total + project.heapGib, 0)
      expect(claimed).toBeLessThanOrEqual(budget)
    }
  })

  it('still fills a CI batch with the cheap projects rather than serializing everything', () => {
    // Why: strict serialization measured ~60% slower than pairing the cheap work alongside.
    expect(planFor(CI_RUNNER).length).toBeLessThan(TYPECHECK_PROJECTS.length)
  })

  it('leaves a roomy machine fully parallel', () => {
    expect(planFor(DEV_LAPTOP)).toHaveLength(1)
  })

  it('serializes on a single core', () => {
    const batches = planFor({ totalBytes: 64 * 1024 ** 3, parallelism: 1 })
    expect(batches).toHaveLength(TYPECHECK_PROJECTS.length)
    expect(batches.every((batch) => batch.length === 1)).toBe(true)
  })

  it('runs a project that alone exceeds the budget instead of stalling', () => {
    const batches = planTypecheckBatches([{ config: 'huge.json', heapGib: 512 }], {
      budgetGib: admissibleHeapGib(2 * 1024 ** 3),
      parallelism: 4
    })
    expect(batches).toEqual([[{ config: 'huge.json', heapGib: 512 }]])
  })

  it('schedules every project exactly once', () => {
    const scheduled = planFor(CI_RUNNER)
      .flat()
      .map((project) => project.config)
      .sort()
    expect(scheduled).toEqual(TYPECHECK_PROJECTS.map((project) => project.config).sort())
  })

  it('never lets one project outgrow a CI runner on its own', () => {
    // A single project over budget runs anyway, so this is the ceiling the pool cannot rescue.
    const heaviest = Math.max(...TYPECHECK_PROJECTS.map((project) => project.heapGib))
    expect(heaviest).toBeLessThanOrEqual(admissibleHeapGib(CI_RUNNER.totalBytes))
  })
})

describe('workspace package test typecheck', () => {
  const packagesDir = join(repoRoot, 'src', 'packages')
  const packageTestProjects = readdirSync(packagesDir)
    .map((name) => join(packagesDir, name, 'tsconfig.test.json'))
    .filter((config) => existsSync(config))
    .map((config) => relative(repoRoot, config).split(sep).join('/'))

  it('type-checks every package test project, which no root project includes', () => {
    expect(packageTestProjects).toContain('src/packages/process-host/tsconfig.test.json')
    const scheduled = TYPECHECK_PROJECTS.map((project) => project.config)
    expect(scheduled).toEqual(expect.arrayContaining(packageTestProjects))
  })

  it("resolves a package project's compiler from that package, not the root", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-typecheck-compiler-')))
    try {
      const writeCompiler = (directory, version) => {
        const compilerDir = join(root, directory, 'node_modules', 'typescript')
        mkdirSync(join(compilerDir, 'bin'), { recursive: true })
        writeFileSync(
          join(compilerDir, 'package.json'),
          JSON.stringify({ name: 'typescript', version, bin: { tsc: './bin/tsc' } })
        )
        return join(compilerDir, 'bin', 'tsc')
      }
      const rootCompiler = writeCompiler('.', '6.0.0')
      const packageCompiler = writeCompiler('src/packages/example', '7.0.0')
      mkdirSync(join(root, 'config'))

      expect(resolveProjectCompiler('src/packages/example/tsconfig.test.json', root)).toBe(
        packageCompiler
      )
      expect(resolveProjectCompiler('config/tsconfig.node.json', root)).toBe(rootCompiler)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
