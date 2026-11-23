import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  await scratch.close()
  expect(readdirSync(parent)).toEqual([])
})

it('sweeps only operations whose recorded owner is dead', async () => {
  const dead = operation('dead', '2147483646')
  const live = operation('live', String(process.pid))
  const unowned = operation('unowned')
  const scratch = createClaudeImportScratch({ parent })
  expect([existsSync(dead), existsSync(live), existsSync(unowned)]).toEqual([false, true, true])
  await scratch.close()
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

it('shares one quota between imports that grow at the same time', async () => {
  const first = createClaudeImportScratch({ parent, quotaBytes: 1024 * 1024 })
  const second = createClaudeImportScratch({ parent, quotaBytes: 1024 * 1024 })
  writeFileSync(first.filename, Buffer.alloc(768 * 1024))
  expect(second.allowanceBytes()).toBeLessThan(256 * 1024)
  await Promise.all([first.close(), second.close()])
})

it('removes its database when the quota refuses the first write batch', async () => {
  expect(() => createClaudeImportGraph({ parent, quotaBytes: 1024 })).toThrow(
    ClaudeImportResourceError
  )
  await vi.waitFor(() => expect(readdirSync(parent)).toEqual([]))
})
