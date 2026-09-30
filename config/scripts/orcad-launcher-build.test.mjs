import { existsSync, realpathSync, statSync } from 'node:fs'
import { copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildOrcadLauncher } from './orcad-entry-build.mjs'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime'
import { runProcess } from '../../src/shared/child-process/run-process'

const bundledRuntime = resolve('out/orcad', orcadBunRuntimeFilename(process.platform))
const nodeRuntime =
  process.env.ORCA_TEST_NODE_EXECUTABLE ?? (process.versions.bun ? 'node' : process.execPath)
let directory
let launcher
let buildResult

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca launcher boundary '))
  launcher = join(directory, 'orcad.js')
  buildResult = await buildOrcadLauncher(launcher)
})

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps the application graph outside the validated Bun entry', () => {
  const inputs = Object.keys(buildResult.metafile.inputs)
  expect(inputs.some((input) => input.endsWith('/orcad/main.ts'))).toBe(true)
  expect(inputs.some((input) => input.endsWith('/orcad/orcad-app.ts'))).toBe(false)
  expect(inputs.some((input) => input.includes('/persistence/'))).toBe(false)
  expect(
    Object.values(buildResult.metafile.outputs).flatMap((output) => output.imports)
  ).toContainEqual(expect.objectContaining({ path: './orcad-app', external: true }))
})

it('rejects Node without loading application code', async () => {
  const result = await runProcess({ program: nodeRuntime, args: [launcher], timeoutMs: 10_000 })
  expect(result.code, result.stderr).toBe(78)
  expect(result.stderr).toContain('not Node')
})

describe.skipIf(!existsSync(bundledRuntime))('bundled launcher application boundary', () => {
  beforeAll(async () => {
    await copyFile(bundledRuntime, join(directory, orcadBunRuntimeFilename(process.platform)))
    await writeFile(join(directory, '.build-target'), `${process.platform}-${process.arch}\n`)
    await writeFile(
      join(directory, 'orcad-app.js'),
      `
      const { Database } = require('bun:sqlite')
      const db = new Database(':memory:')
      const value = db.query('SELECT 42 AS value').get().value
      db.close()
      console.log(JSON.stringify({ bun: process.versions.bun, value, args: process.argv.slice(2), entry: process.argv[1] }))
    `
    )
  })

  it('loads a Bun-only application directly without changing arguments', async () => {
    const result = await runProcess({
      program: join(directory, orcadBunRuntimeFilename(process.platform)),
      args: [launcher, '--data-dir', 'a path with spaces'],
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    const { entry, ...response } = JSON.parse(result.stdout)
    expect(response).toEqual({
      bun: ORCAD_BUN_VERSION,
      value: 42,
      args: ['--data-dir', 'a path with spaces']
    })
    const actual = statSync(entry, { bigint: true })
    const expected = statSync(launcher, { bigint: true })
    expect(actual.ino).toBe(expected.ino)
    expect(actual.dev).toBe(expected.dev)
  })

  it.skipIf(process.platform === 'win32')(
    'resolves a directly launched symlink before locating application assets',
    async () => {
      const links = await mkdtemp(join(tmpdir(), 'orca launcher link '))
      try {
        const link = join(links, 'orcad.js')
        await symlink(launcher, link)
        const result = await runProcess({
          program: join(directory, orcadBunRuntimeFilename(process.platform)),
          args: [link],
          timeoutMs: 10_000
        })
        expect(result.code, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout).entry).toBe(realpathSync(launcher))
      } finally {
        await rm(links, { recursive: true, force: true })
      }
    }
  )

  it('reports a missing application as a configuration fault', async () => {
    await rm(join(directory, 'orcad-app.js'))
    const result = await runProcess({
      program: join(directory, orcadBunRuntimeFilename(process.platform)),
      args: [launcher],
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(78)
    expect(result.stderr).toContain('application could not load')
  })
})
