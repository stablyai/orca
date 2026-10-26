import { describe, expect, it } from 'vitest'
import { collectSalvageDrops } from '../../../src/shared/zod-salvage'
import {
  gitBranchCompareResultSchema,
  gitCommitCompareResultSchema
} from './git-compare-reply-schema'
import { gitHistoryResultSchema } from './git-history-reply-schema'
import {
  buildMobileSourceControlSections,
  countStagedEntries,
  countUnstagedEntries,
  isMobileGitStageableEntry
} from './mobile-git-status'
import { gitStatusHostPayloadSchema, gitStatusProjectionSchema } from './git-status-reply-schema'
import { hostedReviewEligibilitySchema } from './hosted-review-reply-schema'

describe('source-control reply schemas', () => {
  it('decodes a reply from a host that sends members this client does not declare', () => {
    // Strict schemas would reject new host fields or silently drop dirty rows.
    const fromNewerHost = {
      entries: [
        { path: 'src/app.ts', status: 'modified', area: 'staged', submoduleRoot: 'vendor/x' }
      ],
      conflictOperation: 'unknown',
      branch: 'feature',
      didHitLimit: false
    }
    const parsed = gitStatusHostPayloadSchema.safeParse(fromNewerHost)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.entries).toHaveLength(1)
    expect(parsed.data?.entries[0]?.submoduleRoot).toBe('vendor/x')
    expect(parsed.data?.didHitLimit).toBe(false)
  })

  it('keeps a commit whose timestamp the host sent as null', () => {
    // Number-or-absent would drop null timestamps.
    const parsed = gitHistoryResultSchema.safeParse({
      items: [{ id: 'a'.repeat(40), parentIds: [], subject: '', timestamp: null }]
    })
    expect(parsed.data?.items).toHaveLength(1)
  })

  it('passes an eligibility token through that the shared union does not list', () => {
    const parsed = hostedReviewEligibilitySchema.safeParse({
      provider: 'gitlab',
      reviewLookupOutcome: 'none'
    })
    expect(parsed.data?.reviewLookupOutcome).toBe('none')
  })

  it('writes every projected member out, absent ones included', () => {
    // Projection preserves keys as undefined; optional-key omission would change the established shape.
    const projected = gitStatusProjectionSchema.parse({
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }]
    })
    expect(projected && Object.keys(projected).sort()).toEqual([
      'branch',
      'conflictOperation',
      'entries',
      'head',
      'upstreamStatus'
    ])
    expect(projected?.entries[0] && Object.keys(projected.entries[0]).sort()).toEqual([
      'added',
      'area',
      'conflictKind',
      'conflictStatus',
      'conflictStatusSource',
      'oldPath',
      'path',
      'removed',
      'status'
    ])
  })

  it('reports a dropped entry instead of thinning the list in silence', () => {
    const salvaged = collectSalvageDrops(() =>
      gitStatusHostPayloadSchema.safeParse({
        entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }, { path: 42 }]
      })
    )
    expect(salvaged.value.success).toBe(true)
    expect(salvaged.droppedCount).toBe(1)
    expect(salvaged.droppedPaths).toEqual(['1'])
  })
})

// Unknown routing enums must degrade to values readers already handle, preserving renderable replies.

const STATUS_ENTRY = { path: 'src/app.ts', status: 'modified', area: 'staged' }

describe('an enum arm this build does not know', () => {
  it('degrades a compare summary status rather than refusing the whole compare', () => {
    const parsed = gitBranchCompareResultSchema.safeParse({
      summary: { baseRef: 'origin/main', changedFiles: 1, status: 'shallow-base' }
    })
    expect(parsed.data?.summary.status).toBe('error')
    const absent = gitBranchCompareResultSchema.safeParse({
      summary: { baseRef: 'origin/main', changedFiles: 1 }
    })
    expect(absent.success).toBe(false)
    const wrongType = gitBranchCompareResultSchema.safeParse({
      summary: { baseRef: 'origin/main', changedFiles: 1, status: 7 }
    })
    expect(wrongType.success).toBe(false)
  })

  it('degrades a branch entry status rather than dropping the row', () => {
    const parsed = gitBranchCompareResultSchema.safeParse({
      summary: { baseRef: 'origin/main', changedFiles: 1, status: 'ready' },
      entries: [{ path: 'src/app.ts', status: 'typechange' }]
    })
    expect(parsed.data?.entries?.[0]?.status).toBe('modified')
    const absent = gitBranchCompareResultSchema.safeParse({
      summary: { baseRef: 'origin/main', changedFiles: 1, status: 'ready' },
      entries: [{ path: 'src/app.ts' }]
    })
    expect(absent.data?.entries).toHaveLength(0)
  })

  it('degrades an optional changed-file status rather than dropping the row', () => {
    const parsed = gitCommitCompareResultSchema.safeParse({
      entries: [{ path: 'src/app.ts', status: 'typechange' }]
    })
    expect(parsed.data?.entries[0]?.status).toBe('modified')
    const absent = gitCommitCompareResultSchema.safeParse({ entries: [{ path: 'src/app.ts' }] })
    expect(absent.data?.entries[0]?.status).toBeUndefined()
  })

  it('degrades a working-tree entry status rather than dropping the row', () => {
    const parsed = gitStatusHostPayloadSchema.safeParse({
      entries: [{ ...STATUS_ENTRY, status: 'typechange' }]
    })
    expect(parsed.data?.entries[0]?.status).toBe('modified')
    const absent = gitStatusHostPayloadSchema.safeParse({
      entries: [{ path: 'src/app.ts', area: 'staged' }]
    })
    expect(absent.data?.entries).toHaveLength(0)
  })

  it('degrades the same status inside the normalized projection', () => {
    const projected = gitStatusProjectionSchema.parse({
      entries: [{ ...STATUS_ENTRY, status: 'typechange' }]
    })
    expect(projected?.entries[0]?.status).toBe('modified')
  })

  it('keeps a row whose conflict tokens it does not know, reading them as absent', () => {
    const parsed = gitStatusHostPayloadSchema.safeParse({
      entries: [
        {
          ...STATUS_ENTRY,
          conflictKind: 'both_renamed',
          conflictStatus: 'resolved_upstream',
          conflictStatusSource: 'relay'
        }
      ]
    })
    expect(parsed.data?.entries).toHaveLength(1)
    expect(parsed.data?.entries[0]?.conflictKind).toBeUndefined()
    expect(parsed.data?.entries[0]?.conflictStatus).toBeUndefined()
    expect(parsed.data?.entries[0]?.conflictStatusSource).toBeUndefined()
  })

  it('passes a hosted-review provider through instead of degrading it', () => {
    // Provider round-trips; enum fallback would rewrite the host’s token.
    const parsed = hostedReviewEligibilitySchema.safeParse({ provider: 'codeberg' })
    expect(parsed.data?.provider).toBe('codeberg')
    expect(hostedReviewEligibilitySchema.safeParse({}).success).toBe(false)
    expect(hostedReviewEligibilitySchema.safeParse({ provider: 7 }).success).toBe(false)
  })

  it('keeps a row whose staging area it does not know, in no section', () => {
    // Unknown area withholds actions but keeps the row in conflict gating.
    const parsed = gitStatusHostPayloadSchema.safeParse({
      entries: [{ ...STATUS_ENTRY, area: 'stashed', conflictStatus: 'unresolved' }]
    })
    const entries = parsed.data?.entries ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]?.area).toBeUndefined()
    expect(entries.some((entry) => entry.conflictStatus === 'unresolved')).toBe(true)
    expect(buildMobileSourceControlSections(entries)).toHaveLength(0)
    expect(isMobileGitStageableEntry(entries[0] ?? STATUS_ENTRY)).toBe(false)
    expect(countStagedEntries(entries)).toBe(0)
    expect(countUnstagedEntries(entries)).toBe(0)
  })

  it('reads an explicit null entries list as an empty compare', () => {
    // Explicit null entries must reach the consumer’s empty-list fallback.
    const parsed = gitBranchCompareResultSchema.safeParse({
      summary: { baseRef: 'origin/main', changedFiles: 0, status: 'ready' },
      entries: null
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.entries ?? []).toEqual([])
  })
})
