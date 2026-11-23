import { existsSync } from 'node:fs'
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
