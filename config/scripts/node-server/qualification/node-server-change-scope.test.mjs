import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { classifyNodeServerChanges, collectNodeServerInputs } from './node-server-change-scope.mjs'

const temporaryDirs = []
afterEach(() => {
  for (const root of temporaryDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function moduleTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'node-server-scope-'))
  temporaryDirs.push(root)
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }
  return root
}

function workspaceTree(imported = '@orca/process-host') {
  const manifest = (name, source) =>
    JSON.stringify({
      name,
      exports: { '.': { 'orca-source': source, default: './dist/index.js' } }
    })
  return moduleTree({
    'entry.ts': `export * from '${imported}'`,
    'pnpm-workspace.yaml': 'packages:\n  - src/packages/*\n',
    'src/packages/process-host/package.json': manifest(
      '@orca/process-host',
      './src/run-process.ts'
    ),
    'src/packages/process-host/src/run-process.ts':
      "import('@orca/byte-buffer'); require('./private'); export const value = 1",
    'src/packages/process-host/src/private.ts': 'module.exports = 2',
    'src/packages/process-host/dist/index.js': "require('./missing-stale-output')",
    'src/packages/byte-buffer/package.json': manifest('@orca/byte-buffer', './src/byte-buffer.ts'),
    'src/packages/byte-buffer/src/byte-buffer.ts': 'export const value = 3',
    'src/packages/unrelated/package.json': manifest('@orca/unrelated', './src/unrelated.ts'),
    'src/packages/unrelated/src/unrelated.ts': 'throw Error("unrelated")'
  })
}

it('tracks workspace source and manifest closures without trusting dist or widening to unrelated packages', async () => {
  const root = workspaceTree()
  const inputs = await collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  expect([...inputs].sort()).toEqual([
    'entry.ts',
    'src/packages/byte-buffer/package.json',
    'src/packages/byte-buffer/src/byte-buffer.ts',
    'src/packages/process-host/package.json',
    'src/packages/process-host/src/private.ts',
    'src/packages/process-host/src/run-process.ts'
  ])
  for (const file of [
    'src/packages/process-host/package.json',
    'src/packages/process-host/src/private.ts',
    'src/packages/byte-buffer/src/byte-buffer.ts'
  ]) {
    expect((await classifyNodeServerChanges([file], async () => inputs)).shouldRun).toBe(true)
  }
  expect(
    (
      await classifyNodeServerChanges(
        ['src/packages/unrelated/src/unrelated.ts'],
        async () => inputs
      )
    ).shouldRun
  ).toBe(false)
})

it('retains qualification when a removed ordinary unit file breaks an actual import', async () => {
  const removed = 'src/main/persistence/example/removed.test.ts'
  const root = moduleTree({ 'entry.ts': `import './${removed}'` })
  const result = await classifyNodeServerChanges([removed], () =>
    collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  )
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBe(true)
  expect(result.reason).toContain('Dependency graph unavailable')
  expect(result.reason).toContain('removed.test.ts')
})
