import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importCodexHomeHistory } from './codex-home-history-import'

let root: string
let source: string
let destination: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-history-import-'))
  source = join(root, 'source')
  destination = join(root, 'account')
  mkdirSync(source)
  mkdirSync(destination)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

it('copies active and archived conversations without copying source configuration or databases', async () => {
  const rollout = 'rollout-2026-11-17T10-00-00-11111111-1111-4111-8111-111111111111.jsonl'
  mkdirSync(join(source, 'sessions', '2026'), { recursive: true })
  mkdirSync(join(source, 'archived_sessions'))
  writeFileSync(join(source, 'sessions', '2026', rollout), 'active conversation')
  writeFileSync(join(source, 'archived_sessions', rollout), 'archived conversation')
  writeFileSync(join(source, 'session_index.jsonl'), 'session titles')
  writeFileSync(join(source, 'history.jsonl'), 'prompt history')
  writeFileSync(join(source, 'config.toml'), 'source configuration')
  writeFileSync(join(source, 'state_5.sqlite'), 'source index')
  expect(await importCodexHomeHistory(source, destination)).toEqual(
    new Map([['11111111-1111-4111-8111-111111111111', '2026-11-17T10-00-00']])
  )
  expect(readFileSync(join(destination, 'sessions', '2026', rollout), 'utf8')).toBe(
    'active conversation'
  )
  expect(readFileSync(join(destination, 'archived_sessions', rollout), 'utf8')).toBe(
    'archived conversation'
  )
  expect(readFileSync(join(destination, 'session_index.jsonl'), 'utf8')).toBe('session titles')
  expect(readFileSync(join(destination, 'history.jsonl'), 'utf8')).toBe('prompt history')
  expect(readFileSync(join(source, 'sessions', '2026', rollout), 'utf8')).toBe(
    'active conversation'
  )
  expect(existsSync(join(destination, 'config.toml'))).toBe(false)
  expect(existsSync(join(destination, 'state_5.sqlite'))).toBe(false)
})

it('rejects linked history instead of importing a shared store', async () => {
  const shared = join(root, 'shared')
  mkdirSync(shared)
  writeFileSync(join(shared, 'conversation.jsonl'), 'other account')
  symlinkSync(shared, join(source, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(importCodexHomeHistory(source, destination)).rejects.toThrow('contains links')
  expect(readFileSync(join(shared, 'conversation.jsonl'), 'utf8')).toBe('other account')
})

it('rejects destinations inside the source before copying', async () => {
  const nested = join(source, 'sessions', 'account')
  mkdirSync(nested, { recursive: true })
  await expect(importCodexHomeHistory(source, nested)).rejects.toThrow('outside the source home')
})
