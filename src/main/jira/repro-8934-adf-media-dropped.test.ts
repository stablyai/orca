/**
 * Issue #8934 — Jira issue images do not render in Tasks drawer.
 *
 * Jira ADF stores pasted screenshots as media / mediaSingle / mediaInline
 * nodes. adfToMarkdownText has no cases for those types, so images are
 * silently dropped. ISSUE_FIELDS also omits `attachment`, so even if media
 * were mapped there is no authenticated download path on getIssue.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/jira/repro-8934-adf-media-dropped.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adfToMarkdownText } from './adf-markdown'

const adfSource = readFileSync(join(__dirname, 'adf-markdown.ts'), 'utf8')
const issuesSource = readFileSync(join(__dirname, 'issues.ts'), 'utf8')

describe('#8934 Jira ADF media nodes dropped in Tasks drawer', () => {
  it('drops mediaSingle / media / mediaInline with no markdown image output', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Acceptance criteria:' }]
        },
        {
          type: 'mediaSingle',
          attrs: { layout: 'center' },
          content: [
            {
              type: 'media',
              attrs: {
                id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                type: 'file',
                collection: '',
                width: 800,
                height: 600
              }
            }
          ]
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'mediaInline',
              attrs: {
                id: 'ffffffff-1111-2222-3333-444444444444',
                type: 'file',
                collection: ''
              }
            },
            { type: 'text', text: ' after image' }
          ]
        }
      ]
    }

    const md = adfToMarkdownText(adf)
    expect(md).toContain('Acceptance criteria:')
    expect(md).toContain('after image')
    // Bug: no image markdown, data URL, or media id retained
    expect(md).not.toMatch(/!\[/)
    expect(md).not.toMatch(/aaaaaaaa-bbbb/)
    expect(md).not.toMatch(/data:image/)
    expect(md).not.toMatch(/attachment/)
  })

  it('source has no media type handlers and ISSUE_FIELDS omits attachment', () => {
    expect(adfSource).not.toMatch(/type === 'media'/)
    expect(adfSource).not.toMatch(/mediaSingle|mediaInline/)
    expect(issuesSource).toMatch(/const ISSUE_FIELDS = \[/)
    expect(issuesSource).not.toMatch(/'attachment'/)
  })

  it('still converts ordinary paragraph/heading text (regression guard)', () => {
    expect(
      adfToMarkdownText({
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Use Case' }]
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Only text here.' }]
          }
        ]
      })
    ).toBe('## Use Case\n\nOnly text here.')
  })
})
