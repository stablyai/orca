import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const crossVolume = vi.hoisted(() => {
  const state: { on: boolean; beforeLink?: (targetPath: string) => void } = { on: false }
  return state
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      crossVolume.beforeLink?.(String(args[1]))
      if (crossVolume.on) {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
      }
      return actual.link(...args)
    }
  }
})

import { bridgeCodexSessionsIntoAccountHome } from './codex-account-session-bridge'

const ROLLOUT = join(
  '2026',
  '10',
  '28',
  'rollout-2026-10-28T10-00-00-019a0000-0000-7000-8000-00000000000a.jsonl'
)
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-hardlink-only-'))
  mkdirSync(join(root, 'account', 'sessions', '2026', '10', '28'), { recursive: true })
  writeFileSync(join(root, 'account', 'sessions', ROLLOUT), '{"type":"session_meta"}\n')
  mkdirSync(join(root, 'codex'))
  crossVolume.on = true
})

afterEach(() => {
  crossVolume.on = false
  crossVolume.beforeLink = undefined
  rmSync(root, { recursive: true, force: true })
})

it('skips a cross-volume rollout for a hardlink-only target, creating nothing', async () => {
  const summary = await bridgeCodexSessionsIntoAccountHome({
    targetCodexHomePath: join(root, 'codex'),
    sourceCodexHomePaths: [join(root, 'account')],
    hardlinkOnly: true
  })

  expect(summary).toMatchObject({ scannedFiles: 1, linkedFiles: 0, skippedFiles: 1 })
  expect(summary.bridgedThreads.size).toBe(0)
  expect(existsSync(join(root, 'codex', 'sessions'))).toBe(false)
})

it('still falls back to a symlink between Orca-managed homes', async () => {
  const summary = await bridgeCodexSessionsIntoAccountHome({
    targetCodexHomePath: join(root, 'codex'),
    sourceCodexHomePaths: [join(root, 'account')]
  })

  expect(summary).toMatchObject({ linkedFiles: 1, skippedFiles: 0 })
  expect(lstatSync(join(root, 'codex', 'sessions', ROLLOUT)).isSymbolicLink()).toBe(true)
})

it('does not count a dangling link another writer made after the listing as bridged', async () => {
  crossVolume.on = false
  crossVolume.beforeLink = (targetPath) => symlinkSync(join(root, 'missing.jsonl'), targetPath)

  const summary = await bridgeCodexSessionsIntoAccountHome({
    targetCodexHomePath: join(root, 'codex'),
    sourceCodexHomePaths: [join(root, 'account')]
  })

  expect(summary).toMatchObject({ scannedFiles: 1, linkedFiles: 0 })
  expect(summary.bridgedThreads.size).toBe(0)
})
