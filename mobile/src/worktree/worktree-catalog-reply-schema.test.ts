import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { retiredWorktreeNamesSchema, worktreeCatalogSchema } from './worktree-catalog-reply-schema'

function reads<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`expected a readable reply: ${parsed.error.message}`)
  }
  return parsed.data
}

function refuses(schema: z.ZodType<unknown, unknown>, value: unknown): boolean {
  return !schema.safeParse(value).success
}

describe('the catalog reads both arms of the host union', () => {
  it('reads a full snapshot', () => {
    const reply = { snapshotId: 'snapshot-1', worktrees: [{ worktreeId: 'w-1' }] }
    expect(reads(worktreeCatalogSchema, reply).worktrees).toEqual([{ worktreeId: 'w-1' }])
  })

  it('reads an unchanged poll, which carries no rows at all', () => {
    // RuntimeWorktreePsUnchangedResult is `{ unchanged, snapshotId }`; requiring `worktrees` would
    // refuse every conditional poll the snapshot client makes.
    const unchanged = reads(worktreeCatalogSchema, { unchanged: true, snapshotId: 's-1' })
    expect(unchanged.unchanged).toBe(true)
    expect(unchanged.worktrees).toBe(undefined)
  })

  it('leaves the rows opaque for the three screens that each project their own', () => {
    const rows = [{ worktreeId: 'w-1', displayName: 'One' }, 'not-a-row']
    expect(reads(worktreeCatalogSchema, { worktrees: rows }).worktrees).toEqual(rows)
  })

  it('names a reply that is not a catalog envelope', () => {
    expect(refuses(worktreeCatalogSchema, null)).toBe(true)
    expect(refuses(worktreeCatalogSchema, undefined)).toBe(true)
  })

  it('drops a worktrees that is not an array, as Array.isArray did', () => {
    expect(reads(worktreeCatalogSchema, { worktrees: 'all' }).worktrees).toBe(undefined)
  })
})

describe('the retired-name registry stays opaque', () => {
  it('takes every shape readRetiredNameRegistryForRepo guards', () => {
    expect(refuses(retiredWorktreeNamesSchema, null)).toBe(false)
    expect(refuses(retiredWorktreeNamesSchema, undefined)).toBe(false)
    expect(refuses(retiredWorktreeNamesSchema, { retiredNamesByRepo: { 'repo-1': ['a'] } })).toBe(
      false
    )
  })
})
