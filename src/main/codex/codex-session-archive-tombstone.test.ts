import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, linkSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeRedundantActiveCodexSessionHardlink } from './codex-session-archive-tombstone'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

describe('archived Codex session tombstone', () => {
  it('removes an active backfill hardlink to the archived managed rollout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-archive-'))
    roots.push(root)
    const managed = join(root, 'managed.jsonl')
    const active = join(root, 'active.jsonl')
    const archived = join(root, 'archived.jsonl')
    writeFileSync(managed, 'worker rollout\n')
    linkSync(managed, active)
    linkSync(managed, archived)

    await removeRedundantActiveCodexSessionHardlink(
      managed,
      active,
      lstatSync(archived, { bigint: true })
    )

    expect(existsSync(active)).toBe(false)
    expect(existsSync(managed)).toBe(true)
    expect(existsSync(archived)).toBe(true)
  })

  it('preserves an active file with different identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-archive-'))
    roots.push(root)
    const managed = join(root, 'managed.jsonl')
    const active = join(root, 'active.jsonl')
    const archived = join(root, 'archived.jsonl')
    writeFileSync(managed, 'managed rollout\n')
    linkSync(managed, archived)
    writeFileSync(active, 'different active rollout\n')

    await removeRedundantActiveCodexSessionHardlink(
      managed,
      active,
      lstatSync(archived, { bigint: true })
    )

    expect(existsSync(active)).toBe(true)
  })
})
