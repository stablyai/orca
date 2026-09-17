import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  githubPullRequestChecksSchema,
  githubPullRequestFileContentsSchema,
  hostedIssueCreatedSchema,
  linearIssueCreatedSchema,
  linearIssueUpdatedSchema,
  taskItemMutationSchema,
  taskMutationConfirmationSchema
} from './task-item-state-reply-schema'

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

describe('creating an item', () => {
  it('reads the recorded GitHub and GitLab create replies unchanged', () => {
    const created = reads(hostedIssueCreatedSchema, {
      ok: true,
      number: 11,
      url: 'https://github.com/owner/repo/issues/11'
    })
    expect(created).toMatchObject({ ok: true, number: 11 })
  })

  it('reads a number the composer would not have accepted as absent', () => {
    expect(reads(hostedIssueCreatedSchema, { ok: true, number: '11' }).number).toBeUndefined()
  })

  it('leaves id and identifier to the Linear call site, which words that refusal itself', () => {
    expect(reads(linearIssueCreatedSchema, { ok: true }).id).toBeUndefined()
    expect(
      reads(linearIssueCreatedSchema, { ok: true, id: 'issue-3', identifier: 'ENG-3' }).identifier
    ).toBe('ENG-3')
    expect(refuses(linearIssueCreatedSchema, null)).toBe(true)
  })
})

describe('the nine writes that share one reader', () => {
  it('is the mutation envelope, not a second copy of it', () => {
    expect(reads(taskItemMutationSchema, { ok: true })).toMatchObject({ ok: true })
    expect(refuses(taskItemMutationSchema, null)).toBe(true)
  })
})

describe('the checks read', () => {
  it('reads the recorded reply and refuses a payload that is not a list', () => {
    expect(
      reads(githubPullRequestChecksSchema, [
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', url: '' }
      ])
    ).toHaveLength(1)
    expect(refuses(githubPullRequestChecksSchema, { checks: [] })).toBe(true)
    expect(refuses(githubPullRequestChecksSchema, null)).toBe(true)
  })
})

describe('the file-contents read', () => {
  it('reads the recorded reply through untouched, because nothing in it is required', () => {
    const recorded = { oldContent: 'a', newContent: 'b', truncated: false }
    expect(reads(githubPullRequestFileContentsSchema, recorded)).toEqual(recorded)
  })

  it('still names a payload that is not the container', () => {
    expect(refuses(githubPullRequestFileContentsSchema, null)).toBe(true)
    expect(refuses(githubPullRequestFileContentsSchema, 'a\nb')).toBe(true)
  })

  it('reads the host contract when a host sends it', () => {
    const host = { original: 'a', modified: 'b', originalIsBinary: false, modifiedIsBinary: false }
    expect(reads(githubPullRequestFileContentsSchema, host)).toMatchObject(host)
  })
})

describe('the two unread replies', () => {
  it('reads anything for the Linear state write, whose body no call site looks at', () => {
    expect(refuses(linearIssueUpdatedSchema, null)).toBe(false)
    expect(refuses(linearIssueUpdatedSchema, 'accepted')).toBe(false)
  })
})

describe('the viewed-state confirmation', () => {
  it('keeps a real false, which is the refusal the call site words', () => {
    expect(reads(taskMutationConfirmationSchema, true)).toBe(true)
    expect(reads(taskMutationConfirmationSchema, false)).toBe(false)
  })

  it('names a non-boolean instead of reading it as "not confirmed"', () => {
    expect(refuses(taskMutationConfirmationSchema, 'true')).toBe(true)
    expect(refuses(taskMutationConfirmationSchema, { ok: true })).toBe(true)
    expect(refuses(taskMutationConfirmationSchema, null)).toBe(true)
  })
})
