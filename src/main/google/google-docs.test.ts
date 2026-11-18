import { afterEach, describe, expect, it } from 'vitest'
import { googleJson } from './google-api.test-fixture'
import { appendDoc, commentOnDoc, createDoc, readDoc, replaceInDoc } from './google-docs'
import { filesApi, route } from './google-files.test-fixture'

let cleanup = (): void => {}

const requestsOf = (sent: unknown): unknown[] =>
  typeof sent === 'object' && sent !== null && 'requests' in sent && Array.isArray(sent.requests)
    ? sent.requests
    : []
afterEach(() => cleanup())

const DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'

type Paragraph = { text: string; style?: string; bullet?: { listId: string }; insert?: boolean }

/** Paragraphs laid out from index 1, as Docs numbers them. */
function body(paragraphs: Paragraph[]) {
  let at = 1
  return {
    content: paragraphs.map((paragraph) => {
      const start = at
      at += paragraph.text.length
      return {
        startIndex: start,
        endIndex: at,
        paragraph: {
          elements: [
            {
              startIndex: start,
              textRun: {
                content: paragraph.text,
                ...(paragraph.insert ? { suggestedInsertionIds: ['s1'] } : {})
              }
            }
          ],
          ...(paragraph.style ? { paragraphStyle: { namedStyleType: paragraph.style } } : {}),
          ...(paragraph.bullet ? { bullet: paragraph.bullet } : {})
        }
      }
    })
  }
}

const essay = body([
  { text: 'My essay\n', style: 'HEADING_1' },
  { text: 'I recieve the the letter.\n' },
  { text: 'Point one\n', bullet: { listId: 'l1' } },
  { text: 'new idea\n', insert: true }
])

let commentState = 'ALL_SAVED'

async function docsApi(
  doc: ReturnType<typeof body> = essay,
  extra: Parameters<typeof filesApi>[0] = []
) {
  const google = await filesApi([
    route('GET', `/v1/documents/${DOC}`, () =>
      googleJson(200, {
        documentId: DOC,
        title: 'Essay',
        tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: doc } }]
      })
    ),
    route('POST', `/v1/documents/${DOC}:batchUpdate`, (_url, sent) =>
      googleJson(
        200,
        JSON.stringify(sent).includes('insertComment')
          ? { replies: [{}], commentUpdateState: commentState }
          : { replies: [{ replaceAllText: { occurrencesChanged: 1 } }] }
      )
    ),
    ...extra
  ])
  cleanup = google.cleanup
  return google
}

describe('docs read', () => {
  it('keeps headings and lists, marks suggestions inline and lists open comments', async () => {
    const { api } = await docsApi(essay, [
      route('GET', `/drive/v3/files/${DOC}/comments`, () =>
        googleJson(200, {
          comments: [
            {
              content: 'Too long?',
              author: { displayName: 'Sam' },
              quotedFileContent: { value: 'the letter' },
              replies: [{ content: 'Agreed', author: { displayName: 'Ada' } }]
            },
            { content: 'Done', resolved: true }
          ]
        })
      )
    ])
    const view = await readDoc(api, { ref: `https://docs.google.com/document/d/${DOC}/edit` })
    expect(view.text).toBe('# My essay\nI recieve the the letter.\n- Point one\n[+new idea+]')
    expect(view.suggestions).toBe(1)
    expect(view.comments).toEqual([
      {
        author: 'Sam',
        text: 'Too long?',
        quote: 'the letter',
        replies: [{ author: 'Ada', text: 'Agreed' }]
      }
    ])
    expect(view.openComments).toBe(1)
    // A later page repeats no comments.
    expect((await readDoc(api, { ref: DOC, offset: 5 })).comments).toEqual([])
  })
})

describe('docs replace', () => {
  it('sends every pair in one edit, as suggestions when asked', async () => {
    const { api, writes } = await docsApi()
    const view = await replaceInDoc(api, {
      ref: DOC,
      pairs: [
        { old: 'recieve', new: 'receive' },
        { old: 'the the', new: 'the' }
      ],
      suggest: true
    })
    expect(writes()).toHaveLength(1)
    expect(writes()[0]?.body).toEqual({
      requests: [
        {
          replaceAllText: {
            containsText: { text: 'recieve', matchCase: false },
            replaceText: 'receive'
          }
        },
        {
          replaceAllText: {
            containsText: { text: 'the the', matchCase: false },
            replaceText: 'the'
          }
        }
      ],
      writeControl: { writeMode: 'SUGGEST' }
    })
    expect(view.done).toBe('Suggested 1 change; the owner accepts or rejects them in Docs')
  })

  it('changes nothing when any old text is missing, repeated or spans lines', async () => {
    const { api, writes } = await docsApi()
    const attempt = (pairs: { old: string; new: string }[], all = false) =>
      replaceInDoc(api, { ref: DOC, pairs, all })
    await expect(
      attempt([
        { old: 'recieve', new: 'receive' },
        { old: 'teh', new: 'the' }
      ])
    ).rejects.toThrow('Nothing changed. Pair 2 ("teh") isn\'t in the doc.')
    await expect(attempt([{ old: 'THE', new: 'a' }])).rejects.toThrow(
      'is in the doc 2 times. Quote more of the text around it, or pass --all.'
    )
    await expect(attempt([{ old: 'essay\nI', new: 'x' }])).rejects.toThrow('spans a line break')
    expect(writes()).toHaveLength(0)
    await attempt([{ old: 'THE', new: 'a' }], true)
    expect(writes()).toHaveLength(1)
    expect(writes()[0]?.body).not.toHaveProperty('writeControl')
  })
})

describe('docs comment', () => {
  it('anchors a comment to quoted text by its doc positions, in its tab', async () => {
    const { api, writes } = await docsApi()
    await commentOnDoc(api, { ref: DOC, text: 'Typo', on: 'recieve' })
    // "My essay\n" is 1–9, so "I recieve" starts at 10 and "recieve" at 12.
    expect(writes()[0]?.body).toEqual({
      requests: [
        {
          insertComment: { content: 'Typo', range: { startIndex: 12, endIndex: 19, tabId: 't.0' } }
        }
      ]
    })
    await expect(commentOnDoc(api, { ref: DOC, text: 'x', on: 'the' })).rejects.toThrow(
      'is in the doc 2 times'
    )
  })

  it('says so when Google answers but keeps no comment', async () => {
    const { api } = await docsApi()
    commentState = 'ALL_FAILED_UNKNOWN_REASON'
    try {
      await expect(commentOnDoc(api, { ref: DOC, text: 'Typo', on: 'recieve' })).rejects.toThrow(
        "Google didn't save the comment (ALL_FAILED_UNKNOWN_REASON)"
      )
    } finally {
      commentState = 'ALL_SAVED'
    }
  })

  it('comments on the whole doc through Drive when nothing is quoted', async () => {
    const { api, writes } = await docsApi(essay, [
      route('POST', `/drive/v3/files/${DOC}/comments`, () => googleJson(200, { id: 'c1' }))
    ])
    const view = await commentOnDoc(api, { ref: DOC, text: 'Nice work' })
    expect(view.done).toBe('Commented on the doc')
    expect(writes()[0]?.body).toEqual({ content: 'Nice work' })
  })
})

describe('docs create and append', () => {
  it('creates through Drive’s Markdown import', async () => {
    const { api, writes } = await docsApi(essay, [
      route('POST', '/upload/drive/v3/files', () =>
        googleJson(200, {
          id: DOC,
          name: 'Notes',
          mimeType: 'application/vnd.google-apps.document'
        })
      )
    ])
    const view = await createDoc(api, { title: 'Notes', markdown: '# Notes\n- one' })
    expect(view).toMatchObject({ id: DOC, title: 'Notes', done: 'Created' })
    expect(writes()[0]?.raw).toContain('"mimeType":"application/vnd.google-apps.document"')
    expect(writes()[0]?.raw).toContain('Content-Type: text/markdown\r\n\r\n# Notes\n- one')
  })

  it('appends after the last paragraph, in the doc’s first tab', async () => {
    const { api, writes } = await docsApi()
    await appendDoc(api, { ref: DOC, markdown: '## Next\n- ship' })
    const requests = requestsOf(writes()[0]?.body)
    // The last paragraph ends at 55 with its newline at 54; a new paragraph starts after it.
    expect(requests[0]).toEqual({
      insertText: { location: { index: 54, tabId: 't.0' }, text: '\nNext\nship' }
    })
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 55, endIndex: 59, tabId: 't.0' },
        paragraphStyle: { namedStyleType: 'HEADING_2' },
        fields: 'namedStyleType'
      }
    })
    expect(requests.at(-1)).toEqual({
      createParagraphBullets: {
        range: { startIndex: 60, endIndex: 64, tabId: 't.0' },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE'
      }
    })
  })
})
