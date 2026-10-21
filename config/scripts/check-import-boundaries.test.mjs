import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { main } from './check-import-boundaries.mjs'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'

const roots = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-import-boundaries-'))
  roots.push(root)
  for (const [file, contents] of Object.entries({
    'src/packages/process-host/package.json': JSON.stringify({ exports: { '.': './index.ts' } }),
    'src/packages/process-host/src/index.ts': 'export {}',
    'config/process-host-direct-import-baseline.txt': '',
    ...files
  })) {
    const target = path.join(root, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  return root
}

it('parses candidate files once and reports violations from both guards', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const parseSpecifiers = vi.fn(collectModuleSpecifiers)
  const root = fixture({
    'src/main/consumer.ts': `import '@orca/process-host/private'
      const entry = '../shared/workspace-layout/old-client/inner'
      require(entry)`
  })
  expect(main(root, { parseSpecifiers })).toBe(1)
  expect(
    parseSpecifiers.mock.calls.filter(([file]) => file === 'src/main/consumer.ts')
  ).toHaveLength(1)
  expect(error).toHaveBeenCalledWith(expect.stringContaining('not a public process-host export'))
  expect(error).toHaveBeenCalledWith(expect.stringContaining('through old-client-session-tab-rows'))
})

it('uses fresh inputs on every invocation, including newly added files', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const root = fixture()
  expect(main(root)).toBe(0)
  mkdirSync(path.join(root, 'src/main'), { recursive: true })
  writeFileSync(path.join(root, 'src/main/consumer.ts'), "import 'node:child_process'")
  expect(main(root)).toBe(1)
})

it('does not cache a file across an edit at the same path', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const root = fixture({ 'src/main/consumer.ts': "import '@orca/process-host'" })
  expect(main(root)).toBe(0)
  writeFileSync(path.join(root, 'src/main/consumer.ts'), "import '@orca/process-host/private'")
  expect(main(root)).toBe(1)
})

it('rejects malformed source and missing package implementations', () => {
  expect(() => main(fixture({ 'src/main/broken.ts': 'import {' }))).toThrow('Cannot parse')
  const root = fixture()
  rmSync(path.join(root, 'src/packages/process-host/src'), { recursive: true })
  expect(() => main(root)).toThrow('Missing process-host implementation')
})
