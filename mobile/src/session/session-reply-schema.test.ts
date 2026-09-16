import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  clipboardImagePathSchema,
  clipboardImageUnreadReplySchema,
  clipboardImageUploadSlotSchema
} from './clipboard-image-reply-schema'
import {
  branchCompareProjectionSchema,
  reviewGitDiffSchema,
  reviewGitMutationSchema,
  reviewWorktreeMetadataSchema
} from './diff-review-reply-schema'
import {
  githubPrMutationConfirmationSchema,
  githubPrMutationStatusSchemas
} from './github-pr-mutation-reply-schema'
import {
  githubPrForBranchSchema,
  githubPrRepoSlugSchema,
  hostedReviewForBranchSchema
} from './github-pr-read-reply-schema'
import {
  reviewCreatedTerminalSchema,
  reviewTerminalSendAcceptedSchema,
  reviewTerminalTabsSchema
} from './review-terminal-reply-schema'
import {
  aiVaultResumePreparationSchema,
  browserTabCreatedSchema,
  fileTapOpenedSchema
} from './session-launch-reply-schema'
import {
  detectedAgentsSchema,
  markdownTabDocumentSchema,
  runtimeRepoListSchema,
  sessionTerminalInventorySchema,
  sessionWorktreeRecordSchema,
  terminalQuickCommandsSchema,
  workspaceFilePathsSchema
} from './session-read-reply-schema'
import { terminalSendAcceptedSchema } from './session-write-reply-schema'

// One suite per claim the session schemas make. The three kinds of case here are the three kinds of
// decision the schemas encode: a member a consumer reads unguarded is required, an arm set a reader
// compares against degrades rather than refusing, and a reply whose arms need different members is
// declared as variants.

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

describe('required members', () => {
  it('requires the upload slot the chunk loop is addressed to', () => {
    expect(reads(clipboardImageUploadSlotSchema, { uploadId: 'u-1' }).uploadId).toBe('u-1')
    expect(refuses(clipboardImageUploadSlotSchema, {})).toBe(true)
    expect(refuses(clipboardImageUploadSlotSchema, { uploadId: 7 })).toBe(true)
    expect(refuses(clipboardImageUploadSlotSchema, null)).toBe(true)
  })

  it('requires the commit path to be a string', () => {
    expect(reads(clipboardImagePathSchema, '/tmp/a.png')).toBe('/tmp/a.png')
    expect(refuses(clipboardImagePathSchema, { path: '/tmp/a.png' })).toBe(true)
    expect(refuses(clipboardImagePathSchema, undefined)).toBe(true)
  })

  it('reads the two clipboard legs whose body nothing reads', () => {
    expect(refuses(clipboardImageUnreadReplySchema, undefined)).toBe(false)
    expect(refuses(clipboardImageUnreadReplySchema, 'anything')).toBe(false)
    expect(refuses(reviewGitMutationSchema, null)).toBe(false)
  })

  it('requires a created terminal to name the handle the prompt is sent to', () => {
    const tab = { id: 'tab-1', type: 'terminal', title: 'codex', terminal: 'terminal-1' }
    expect(reads(reviewCreatedTerminalSchema, { tab }).terminal).toBe('terminal-1')
    expect(refuses(reviewCreatedTerminalSchema, {})).toBe(true)
    expect(refuses(reviewCreatedTerminalSchema, { tab: { ...tab, terminal: '' } })).toBe(true)
    expect(refuses(reviewCreatedTerminalSchema, { tab: { ...tab, id: '' } })).toBe(true)
  })

  it('requires the tab list the send sheet renders, and drops the rows it cannot address', () => {
    const tabs = reads(reviewTerminalTabsSchema, {
      tabs: [
        { id: 'tab-1', type: 'terminal', terminal: 'terminal-1' },
        { id: 'tab-2', type: 'markdown', title: 'notes.md' },
        { id: 'tab-3', type: 'terminal' }
      ]
    })
    expect(tabs).toEqual([{ id: 'tab-1', terminal: 'terminal-1', title: 'Terminal' }])
    expect(refuses(reviewTerminalTabsSchema, {})).toBe(true)
    expect(refuses(reviewTerminalTabsSchema, { tabs: 'none' })).toBe(true)
  })

  it('requires the three compare members every summary line reads', () => {
    const summary = { baseRef: 'origin/main', compareRef: 'feature', changedFiles: 2 }
    expect(reads(branchCompareProjectionSchema, { summary, entries: [] }).summary.baseRef).toBe(
      'origin/main'
    )
    for (const missing of ['baseRef', 'compareRef', 'changedFiles']) {
      const partial: Record<string, unknown> = { ...summary }
      delete partial[missing]
      expect(refuses(branchCompareProjectionSchema, { summary: partial, entries: [] })).toBe(true)
    }
    expect(refuses(branchCompareProjectionSchema, { summary })).toBe(true)
    expect(refuses(branchCompareProjectionSchema, { summary, entries: {} })).toBe(true)
  })

  it('requires each committed change to have a path and a status it can draw', () => {
    const summary = { baseRef: 'origin/main', compareRef: 'feature', changedFiles: 1 }
    const compare = reads(branchCompareProjectionSchema, {
      summary,
      entries: [
        { path: 'a.ts', status: 'modified' },
        { path: '', status: 'modified' },
        { path: 'b.ts', status: 'untracked' },
        { path: 'c.ts' }
      ]
    })
    expect(compare.entries.map((entry) => entry.path)).toEqual(['a.ts'])
  })

  it('requires the three members a markdown tab publishes into its ready state', () => {
    const doc = { content: '# hi', version: 'v1', isDirty: false }
    expect(reads(markdownTabDocumentSchema, doc).version).toBe('v1')
    for (const missing of ['content', 'version', 'isDirty']) {
      const partial: Record<string, unknown> = { ...doc }
      delete partial[missing]
      expect(refuses(markdownTabDocumentSchema, partial)).toBe(true)
    }
    expect(reads(markdownTabDocumentSchema, { ...doc, editable: 'yes' }).editable).toBeUndefined()
  })

  it('requires the terminal inventory to be a list of handles', () => {
    const inventory = reads(sessionTerminalInventorySchema, {
      terminals: [{ handle: 'h1', title: 'One' }, { title: 'no handle' }]
    })
    expect(inventory.terminals).toEqual([{ handle: 'h1', title: 'One' }])
    expect(refuses(sessionTerminalInventorySchema, {})).toBe(true)
    expect(refuses(sessionTerminalInventorySchema, { terminals: null })).toBe(true)
  })

  it('requires the repo list, and keeps only rows a worktree can be matched against', () => {
    expect(
      reads(runtimeRepoListSchema, {
        repos: [{ id: 'repo-1', connectionId: null }, { path: '/x' }]
      })
    ).toEqual([{ id: 'repo-1', connectionId: null }])
    expect(refuses(runtimeRepoListSchema, {})).toBe(true)
    expect(refuses(runtimeRepoListSchema, { repos: 'one' })).toBe(true)
  })

  it('requires detected agents to be an array the loader can spread', () => {
    expect(reads(detectedAgentsSchema, ['codex', 'claude'])).toEqual(['codex', 'claude'])
    expect(refuses(detectedAgentsSchema, 'codex')).toBe(true)
    expect(refuses(detectedAgentsSchema, null)).toBe(true)
  })

  it('requires files to be a list when present, and reads absence as no suggestions', () => {
    expect(reads(workspaceFilePathsSchema, { files: [{ relativePath: 'a.ts' }, {}] })).toEqual([
      'a.ts'
    ])
    expect(reads(workspaceFilePathsSchema, {})).toEqual([])
    expect(refuses(workspaceFilePathsSchema, { files: 'a.ts' })).toBe(false)
    expect(reads(workspaceFilePathsSchema, { files: 'a.ts' })).toEqual([])
  })

  it('requires the open verdict the tap routes on', () => {
    expect(reads(fileTapOpenedSchema, { opened: true }).opened).toBe(true)
    expect(refuses(fileTapOpenedSchema, {})).toBe(true)
    expect(refuses(fileTapOpenedSchema, { opened: 1 })).toBe(true)
  })

  it('requires the browser tab payload but not the page id inside it', () => {
    expect(reads(browserTabCreatedSchema, { browserPageId: 'p1' }).browserPageId).toBe('p1')
    expect(reads(browserTabCreatedSchema, {}).browserPageId).toBeUndefined()
    expect(refuses(browserTabCreatedSchema, null)).toBe(true)
  })

  it('reads the resume repin through its guards, absence included', () => {
    expect(reads(aiVaultResumePreparationSchema, null)).toBeNull()
    expect(reads(aiVaultResumePreparationSchema, undefined)).toBeUndefined()
    expect(
      reads(aiVaultResumePreparationSchema, { useRealCodexHome: true })?.useRealCodexHome
    ).toBe(true)
    expect(refuses(aiVaultResumePreparationSchema, 'repinned')).toBe(true)
  })

  it('reads a worktree record it cannot parse as no record, the way main did', () => {
    expect(reads(sessionWorktreeRecordSchema, { worktree: 'gone' })).toBeUndefined()
    expect(reads(sessionWorktreeRecordSchema, {})).toBeUndefined()
    expect(
      reads(sessionWorktreeRecordSchema, { worktree: { displayName: 'wt' } })?.displayName
    ).toBe('wt')
    expect(refuses(sessionWorktreeRecordSchema, 7)).toBe(true)
  })

  it('reads the quick-command member through the container, and refuses a bare reply', () => {
    expect(reads(terminalQuickCommandsSchema, { terminalQuickCommands: [] })).toEqual([])
    expect(reads(terminalQuickCommandsSchema, null)).toBeUndefined()
    expect(refuses(terminalQuickCommandsSchema, 'commands')).toBe(true)
  })

  it('requires the review notes container but neither member inside it', () => {
    expect(reads(reviewWorktreeMetadataSchema, {})).toEqual({
      diffComments: undefined,
      mobileDiffReview: undefined
    })
    expect(
      reads(reviewWorktreeMetadataSchema, { worktree: { diffComments: [1] } }).diffComments
    ).toEqual([1])
    expect(refuses(reviewWorktreeMetadataSchema, null)).toBe(true)
  })
})

describe('degrading arm sets', () => {
  it('reads a known check status, degrades one it does not know, and defaults absence', () => {
    const review = { provider: 'github', number: 7 }
    expect(reads(hostedReviewForBranchSchema, { ...review, status: 'success' })?.status).toBe(
      'success'
    )
    expect(reads(hostedReviewForBranchSchema, { ...review, status: 'flaky' })?.status).toBe(
      'pending'
    )
    expect(reads(hostedReviewForBranchSchema, review)?.status).toBe('pending')
  })

  it('reads a known mergeable state, degrades one it does not know, and defaults absence', () => {
    const review = { provider: 'github', number: 7 }
    expect(
      reads(hostedReviewForBranchSchema, { ...review, mergeable: 'CONFLICTING' })?.mergeable
    ).toBe('CONFLICTING')
    expect(reads(hostedReviewForBranchSchema, { ...review, mergeable: 'BEHIND' })?.mergeable).toBe(
      'UNKNOWN'
    )
    expect(reads(hostedReviewForBranchSchema, review)?.mergeable).toBe('UNKNOWN')
  })

  it('reads a provider it does not know as no review rather than as an arm', () => {
    expect(reads(hostedReviewForBranchSchema, { provider: 'gitlab', number: 3 })?.provider).toBe(
      'gitlab'
    )
    expect(reads(hostedReviewForBranchSchema, { provider: 'codeberg', number: 3 })).toBeNull()
    expect(reads(hostedReviewForBranchSchema, { number: 3 })).toBeNull()
    expect(reads(hostedReviewForBranchSchema, null)).toBeNull()
  })

  it('reads a known compare status, degrades one it does not know, and defaults absence', () => {
    const base = { baseRef: 'origin/main', compareRef: 'feature', changedFiles: 0 }
    const read = (status?: unknown) =>
      reads(branchCompareProjectionSchema, {
        summary: status === undefined ? base : { ...base, status },
        entries: []
      }).summary.status
    expect(read('ready')).toBe('ready')
    expect(read('shallow-base')).toBe('error')
    expect(read()).toBe('error')
  })
})

describe('declared variants', () => {
  const [envelopeSchema, voidSchema] = githubPrMutationStatusSchemas

  it('reads a mutation envelope as the status it is', () => {
    expect(reads(envelopeSchema, { ok: false, error: 'nope' })).toEqual({
      structured: true,
      ok: false,
      error: 'nope'
    })
    expect(reads(envelopeSchema, { ok: true })).toEqual({
      structured: true,
      ok: true,
      error: undefined
    })
  })

  it('refuses the envelope arm for a reply with no ok member, which the void arm takes', () => {
    expect(refuses(envelopeSchema, { error: 'nope' })).toBe(true)
    expect(refuses(envelopeSchema, [])).toBe(true)
    expect(reads(voidSchema, { error: 'nope' })).toEqual({ structured: false })
    expect(reads(voidSchema, undefined)).toEqual({ structured: false })
  })

  it('requires the confirmation mutations to answer a boolean', () => {
    expect(reads(githubPrMutationConfirmationSchema, true)).toBe(true)
    expect(reads(githubPrMutationConfirmationSchema, false)).toBe(false)
    expect(refuses(githubPrMutationConfirmationSchema, undefined)).toBe(true)
    expect(refuses(githubPrMutationConfirmationSchema, { ok: true })).toBe(true)
  })

  it('reads each file-diff arm and refuses a kind the screen cannot render', () => {
    expect(
      reads(reviewGitDiffSchema, { kind: 'text', originalContent: 'a', modifiedContent: 'b' })
    ).toEqual({ kind: 'text', originalContent: 'a', modifiedContent: 'b' })
    expect(reads(reviewGitDiffSchema, { kind: 'binary' })).toEqual({ kind: 'binary' })
    expect(reads(reviewGitDiffSchema, { kind: 'too-large', byteLength: 2048 })).toEqual({
      kind: 'too-large',
      byteLength: 2048
    })
    expect(refuses(reviewGitDiffSchema, { kind: 'unknown' })).toBe(true)
    expect(refuses(reviewGitDiffSchema, { kind: 'text', originalContent: 'a' })).toBe(true)
  })

  it('reads each branch-lookup outcome arm, legacy and classified alike', () => {
    expect(reads(githubPrForBranchSchema, { kind: 'no-pr' })).toBeNull()
    expect(reads(githubPrForBranchSchema, null)).toBeNull()
    const upstream = reads(githubPrForBranchSchema, {
      kind: 'upstream-error',
      message: 'rate limited'
    })
    expect(upstream?.kind === 'upstream-error' && upstream.message).toBe('rate limited')
    const classified = reads(githubPrForBranchSchema, {
      kind: 'found',
      pr: { number: 4, state: 'open' }
    })
    expect(classified?.kind === 'found' && classified.pr.number).toBe(4)
    const legacy = reads(githubPrForBranchSchema, { number: 9, state: 'merged' })
    expect(legacy?.kind === 'found' && legacy.pr.state).toBe('merged')
    expect(refuses(githubPrForBranchSchema, { number: 9 })).toBe(true)
  })

  it('reads the repo slug, and null for a repo with no GitHub remote', () => {
    expect(reads(githubPrRepoSlugSchema, { owner: 'o', repo: 'r', host: 'gh.test' })).toEqual({
      owner: 'o',
      repo: 'r',
      host: 'gh.test'
    })
    expect(reads(githubPrRepoSlugSchema, { owner: 'o', repo: 'r', host: '' })).toEqual({
      owner: 'o',
      repo: 'r'
    })
    expect(reads(githubPrRepoSlugSchema, null)).toBeNull()
    expect(refuses(githubPrRepoSlugSchema, { owner: 'o' })).toBe(true)
  })

  it('reads a terminal send as delivered unless the runtime said otherwise', () => {
    expect(reads(terminalSendAcceptedSchema, { send: { accepted: true } })).toBe(true)
    expect(reads(terminalSendAcceptedSchema, { send: { accepted: false } })).toBe(false)
    expect(reads(terminalSendAcceptedSchema, {})).toBe(false)
    expect(reads(reviewTerminalSendAcceptedSchema, { send: { accepted: false } })).toBe(false)
    expect(reads(reviewTerminalSendAcceptedSchema, {})).toBe(true)
    expect(refuses(reviewTerminalSendAcceptedSchema, null)).toBe(true)
  })
})

describe('a newer host is not refused', () => {
  it('passes members no reader knows straight through', () => {
    const doc = reads(markdownTabDocumentSchema, {
      content: 'c',
      version: 'v',
      isDirty: false,
      collaborators: ['a'],
      revisionKind: 'crdt'
    })
    expect(doc.collaborators).toEqual(['a'])
    const slot = reads(clipboardImageUploadSlotSchema, { uploadId: 'u', resumeToken: 'r' })
    expect(slot.resumeToken).toBe('r')
    const inventory = reads(sessionTerminalInventorySchema, {
      terminals: [{ handle: 'h', pane: 'split' }],
      layoutVersion: 3
    })
    expect(inventory.layoutVersion).toBe(3)
  })
})
