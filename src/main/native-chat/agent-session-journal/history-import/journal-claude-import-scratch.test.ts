import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createClaudeImportScratch } from './journal-claude-import-scratch'

it('cleans owned scratch on close', () => {
  const scratch = createClaudeImportScratch()
  expect(existsSync(scratch.root)).toBe(true)
  scratch.close()
  expect(existsSync(scratch.root)).toBe(false)
})

it('refuses a zero aggregate quota', () => {
  expect(() => createClaudeImportScratch({ quotaBytes: 0 })).toThrow('quota')
})

it('refuses an impossible free-space reserve', () => {
  expect(() => createClaudeImportScratch({ reserveBytes: Number.MAX_SAFE_INTEGER })).toThrow('disk')
})

it('sweeps an operation whose recorded owner is dead', () => {
  const dead = join(tmpdir(), 'orca-claude-imports', 'operation-dead-owner')
  mkdirSync(dead, { recursive: true })
  writeFileSync(join(dead, 'owner'), '99999999')
  const scratch = createClaudeImportScratch()
  expect(existsSync(dead)).toBe(false)
  scratch.close()
})

it('cleans scratch when projection fails', () => {
  const scratch = createClaudeImportScratch()
  try {
    throw new Error('cancelled')
  } catch {
    scratch.close()
  }
  expect(existsSync(scratch.root)).toBe(false)
})
