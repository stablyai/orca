import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deleteCodexRolloutsPermanently } from './codex-rollout-permanent-delete'

const asideLookups = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]).includes('.orca-legacy-copy.')) {
        asideLookups.count += 1
      }
      return actual.lstat(...args)
    }
  }
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-rollout-delete-perf-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
  asideLookups.count = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each([2, 7])('looks for legacy copy asides in one home only (%i homes)', async (homeCount) => {
  const homes = Array.from({ length: homeCount }, (_, index) => join(root, `home-${index}`))
  // A Codex that keeps writer locks ran here and holds none, so no chat counts as open.
  mkdirSync(join(homes[0], 'thread-writer-locks'), { recursive: true })
  const chats = 20
  const targets = Array.from({ length: chats }, (_, index) => {
    const id = `0199a1b2-c3d4-7e5f-8a9b-${index.toString(16).padStart(12, '0')}`
    const filePath = join(
      homes[0],
      'sessions',
      '2026',
      '05',
      '20',
      `rollout-2026-05-20T10-00-00-${id}.jsonl`
    )
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, '{"turn":1}\n')
    return { agent: 'codex' as const, filePath }
  })

  await deleteCodexRolloutsPermanently(
    targets,
    async () => false,
    async () => ({ homes, protectedRoots: [] })
  )

  // 16 numbered asides and one probe per chat, whatever the number of homes.
  expect(asideLookups.count).toBe(chats * 17)
})
