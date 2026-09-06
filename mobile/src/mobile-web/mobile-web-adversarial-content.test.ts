import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MobileWebFileEntrySchema } from '../../../src/shared/mobile-web/file-operation-contract'
import {
  MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS,
  MobileWebProviderReviewCommentSchema,
  MobileWebProviderReviewProviderSchema
} from '../../../src/shared/mobile-web/provider-review-contract'
import { MobileWebDiffRowSchema } from '../../../src/shared/mobile-web/source-control-operation-contract'
import { MobileWebTaskGitLabListResultSchema } from '../../../src/shared/mobile-web/task-list-contract'
import { readMobileTasksSourceFamily } from '../tasks/mobile-tasks-source-family.test-support'

const ADVERSARIAL_TEXT = '<img src=x onerror=alert(1)>${globalThis.process?.env}'

describe('mobile web adversarial host content', () => {
  it('keeps bounded filenames, diffs, task titles, and errors as inert strings', () => {
    const file = MobileWebFileEntrySchema.parse({
      relativePath: `${ADVERSARIAL_TEXT}.tsx`,
      basename: `${ADVERSARIAL_TEXT}.tsx`,
      kind: 'text'
    })
    const diff = MobileWebDiffRowSchema.parse({
      index: 0,
      kind: 'add',
      text: ADVERSARIAL_TEXT,
      textTruncated: false,
      newLineNumber: 1
    })
    const tasks = MobileWebTaskGitLabListResultSchema.parse({
      items: [
        {
          id: 'item-1',
          type: 'issue',
          number: 1,
          title: ADVERSARIAL_TEXT,
          state: 'opened',
          url: 'https://gitlab.example.com/group/repo/-/issues/1',
          labels: [],
          updatedAt: '2026-07-28T00:00:00Z',
          author: null
        }
      ],
      error: { type: 'host', message: ADVERSARIAL_TEXT }
    })

    expect(file.relativePath).toContain('<img')
    expect(diff.text).toBe(ADVERSARIAL_TEXT)
    expect(tasks.items[0].title).toBe(ADVERSARIAL_TEXT)
    expect(tasks.error?.message).toBe(ADVERSARIAL_TEXT)
  })

  it('rejects unbounded content and unknown provider identifiers', () => {
    expect(
      MobileWebProviderReviewCommentSchema.safeParse({
        id: 'comment-1',
        author: 'host',
        body: 'x'.repeat(MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS + 1),
        createdAt: '2026-07-28T00:00:00Z',
        kind: 'conversation',
        allowedActions: []
      }).success
    ).toBe(false)
    expect(
      MobileWebTaskGitLabListResultSchema.safeParse({
        items: [],
        error: { message: 'x'.repeat(1_001) }
      }).success
    ).toBe(false)
    expect(MobileWebProviderReviewProviderSchema.safeParse('javascript:alert(1)').success).toBe(
      false
    )
  })

  it('renders these host fields through React Native text surfaces', () => {
    const sources = [
      ...[
        '../files/mobile-file-explorer-row.tsx',
        '../source-control/MobileBranchDiffPreviewDrawer.tsx',
        '../source-control/MobileSourceControlFileRows.tsx'
      ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')),
      readMobileTasksSourceFamily()
    ]

    for (const source of sources) {
      expect(source).toContain('<Text')
      expect(source).not.toContain('dangerouslySetInnerHTML')
      expect(source).not.toMatch(/\.innerHTML\s*=/)
      expect(source).not.toContain('insertAdjacentHTML')
      expect(source).not.toContain('document.write')
    }
  })
})
