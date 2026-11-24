import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createClaudeImportScratch } from './journal-claude-import-scratch'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import { createClaudeImportGraph } from './journal-claude-import-graph'

let parent: string

beforeEach(() => {
  parent = join(mkdtempSync(join(tmpdir(), 'orca-claude-scratch-')), 'imports')
})

afterEach(() => {
  rmSync(join(parent, '..'), { recursive: true, force: true })
})

function operation(name: string, owner?: string): string {
  const path = join(parent, `operation-${name}`)
  mkdirSync(path, { recursive: true })
  if (owner !== undefined) {
    writeFileSync(join(path, 'owner'), owner)
  }
  writeFileSync(join(path, 'graph.sqlite'), Buffer.alloc(4096))
  return path
}

it('removes its operation on close', async () => {
  const scratch = createClaudeImportScratch({ parent })
  writeFileSync(scratch.filename, 'rows')
  scratch.close()
  expect(readdirSync(parent)).toEqual([])
})

it('sweeps only operations whose recorded owner is dead', async () => {
  const dead = operation('dead', '2147483646')
  const live = operation('live', String(process.pid))
  const unowned = operation('unowned')
  const scratch = createClaudeImportScratch({ parent })
  expect([existsSync(dead), existsSync(live), existsSync(unowned)]).toEqual([false, true, true])
  scratch.close()
})

it('charges leftovers it cannot prove dead against the quota', () => {
  operation('live', String(process.pid))
  expect(() => createClaudeImportScratch({ parent, quotaBytes: 4096 })).toThrow(
    ClaudeImportResourceError
  )
  expect(readdirSync(parent)).toHaveLength(1)
})

it('refuses admission inside the free-space reserve without leaving an operation', () => {
  expect(() =>
    createClaudeImportScratch({ parent, reserveBytes: Number.MAX_SAFE_INTEGER })
  ).toThrow(ClaudeImportResourceError)
  expect(readdirSync(parent)).toEqual([])
})

it('charges one import the grant another has not written yet', () => {
  const first = createClaudeImportScratch({ parent, quotaBytes: 1024 * 1024 })
  const second = createClaudeImportScratch({ parent, quotaBytes: 1024 * 1024 })
  expect(first.grantBytes()).toBeGreaterThan(1000 * 1024)
  expect(second.grantBytes()).toBeLessThan(24 * 1024)
  first.close()
  second.close()
})

it('removes its database before reporting that the quota refused the first write batch', () => {
  expect(() => createClaudeImportGraph({ parent, quotaBytes: 1024 })).toThrow(
    ClaudeImportResourceError
  )
  expect(readdirSync(parent)).toEqual([])
})

it('keeps the free-space reserve for grants another import has not written yet', () => {
  mkdirSync(parent, { recursive: true })
  const { bavail, bsize } = statfsSync(parent)
  // Leave about 8 MiB above the reserve; the first grant takes it.
  const reserveBytes = Number(bavail) * Number(bsize) - 8 * 1024 * 1024
  const first = createClaudeImportScratch({ parent, reserveBytes })
  const second = createClaudeImportScratch({ parent, reserveBytes })
  expect(first.grantBytes()).toBeGreaterThan(6 * 1024 * 1024)
  expect(second.grantBytes()).toBeLessThan(2 * 1024 * 1024)
  first.close()
  second.close()
})

it('degrades like a full quota when a grant cannot be recorded', () => {
  const scratch = createClaudeImportScratch({ parent })
  const held = join(dirname(scratch.filename), 'reserved')
  mkdirSync(held)
  writeFileSync(join(held, 'busy'), '')
  expect(() => scratch.grantBytes()).toThrow(ClaudeImportResourceError)
  scratch.close()
})
