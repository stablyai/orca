import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveCli } from './runtime-serve-terminal-smoke.mjs'
import { packagedNodeRuntimePath } from './build-orcad-node.mjs'
import { currentTarget } from './server-build-target.mjs'
import { ORCAD_CLI_ENTRY_FILENAME } from '../../src/shared/orcad-artifacts.ts'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'orca-smoke-cli-'))
  roots.push(root)
  const emitted = join(root, 'out', 'cli', 'index.js')
  mkdirSync(dirname(emitted), { recursive: true })
  writeFileSync(emitted, '')
  return root
}

it('drives Orcad with its packaged CLI and pinned Node even when a desktop CLI exists', () => {
  const root = checkout()
  const directory = join(root, 'out', 'orcad')
  const bundled = join(directory, ORCAD_CLI_ENTRY_FILENAME)
  mkdirSync(dirname(bundled), { recursive: true })
  writeFileSync(bundled, '')
  expect(resolveCli('orcad', root)).toEqual({
    command: packagedNodeRuntimePath(directory, currentTarget()),
    prefix: [bundled]
  })
})

it('fails if the packaged CLI is missing instead of using a stale desktop CLI', () => {
  expect(() => resolveCli('orcad', checkout())).toThrow('Missing packaged Orcad CLI')
})

it('retains the built desktop CLI for the Electron smoke', () => {
  const root = checkout()
  expect(resolveCli('electron', root)).toEqual({
    command: process.execPath,
    prefix: [join(root, 'out', 'cli', 'index.js')]
  })
})
