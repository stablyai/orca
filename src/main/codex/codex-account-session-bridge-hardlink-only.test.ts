import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const crossVolume = vi.hoisted(() => ({ on: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (crossVolume.on) {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
      }
      return actual.linkSync(...args)
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

it('hardlinks on one volume', async () => {
  crossVolume.on = false
  const summary = await bridgeCodexSessionsIntoAccountHome({
    targetCodexHomePath: join(root, 'codex'),
    sourceCodexHomePaths: [join(root, 'account')],
    hardlinkOnly: true
  })

  expect(summary).toMatchObject({ linkedFiles: 1, skippedFiles: 0 })
  expect(summary.bridgedThreads.size).toBe(1)
  expect(lstatSync(join(root, 'codex', 'sessions', ROLLOUT)).isSymbolicLink()).toBe(false)
})
