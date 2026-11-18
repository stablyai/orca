import { afterEach, describe, expect, it, vi } from 'vitest'
import { googleJson } from './google-api.test-fixture'
import { moveDrive, searchDrive, shareDrive, uploadDrive } from './google-drive'
import { downloadDrive, readDrive } from './google-drive-read'
import { driveIdOf, type DriveFile } from './google-drive-files'
import { pdfText } from './google-pdf-text'

// The worker's entry is a build output; here the same reader runs in the test's thread.
vi.mock('./google-pdf-text-client', () => ({
  pdfTextViaWorker: (data: Uint8Array) => pdfText(data)
}))
import { bytesResponse, filesApi, route } from './google-files.test-fixture'

let cleanup = (): void => {}
afterEach(() => cleanup())

async function apiWith(routes: Parameters<typeof filesApi>[0]) {
  const google = await filesApi(routes)
  cleanup = google.cleanup
  return google
}

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const FOLDER_ID = '0BfOlDeRiDqWeRtYuIoPaSdFgHjKl'
// Each answer is a new version, so one test's read text is never another's.
let version = 0
const file = (id: string, name: string, mimeType: string, extra: Partial<DriveFile> = {}) => ({
  id,
  name,
  mimeType,
  modifiedTime: new Date(Date.UTC(2026, 10, 2) + ++version * 1000).toISOString(),
  owners: [{ emailAddress: 'ada@acme.dev' }],
  webViewLink: `https://drive.google.com/file/d/${id}/view`,
  ...extra
})
const files = (...list: Partial<DriveFile>[]) => googleJson(200, { files: list })
const meta = (answer: DriveFile) =>
  route('GET', /^\/drive\/v3\/files\/[^/]+$/, () => googleJson(200, answer))

describe('Drive file refs', () => {
  it('takes ids and every Google link shape, and leaves short words to folder names', () => {
    expect(driveIdOf(`https://docs.google.com/document/d/${DOC_ID}/edit#heading=h.1`)).toBe(DOC_ID)
    expect(driveIdOf(`https://docs.google.com/spreadsheets/u/1/d/${DOC_ID}/edit`)).toBe(DOC_ID)
    expect(driveIdOf(`https://drive.google.com/drive/folders/${FOLDER_ID}`)).toBe(FOLDER_ID)
    expect(driveIdOf(`https://drive.google.com/open?id=${DOC_ID}`)).toBe(DOC_ID)
    expect(driveIdOf(DOC_ID)).toBe(DOC_ID)
    expect(driveIdOf('Q4')).toBeNull()
    expect(() => driveIdOf('https://docs.google.com/')).toThrow('no file id')
  })
})

describe('Drive search and list', () => {
  it('searches names and text in every drive, inside a folder found by name', async () => {
    const { api, sent } = await apiWith([
      route('GET', '/drive/v3/files', (url) =>
        url.searchParams.get('q')?.startsWith('mimeType')
          ? files({ id: FOLDER_ID, name: 'Q4' })
          : googleJson(200, {
              files: [file(DOC_ID, 'Budget', 'application/vnd.google-apps.spreadsheet')],
              nextPageToken: 'p2'
            })
      )
    ])
    const view = await searchDrive(api, { query: "Ada's budget", in: 'Q4' })
    expect(view.folder).toEqual({ id: FOLDER_ID, name: 'Q4' })
    expect(view.files[0]).toMatchObject({ id: DOC_ID, name: 'Budget', owner: 'ada@acme.dev' })
    expect(view.nextPageToken).toBe('p2')
    const search = sent[1]?.url
    expect(search?.searchParams.get('q')).toBe(
      `(name contains 'Ada\\'s budget' or fullText contains 'Ada\\'s budget') and '${FOLDER_ID}' in parents and trashed = false`
    )
    expect(search?.searchParams.get('corpora')).toBe('allDrives')
    expect(search?.searchParams.get('orderBy')).toBeNull()
  })

  it('refuses a folder name that matches several, and one that matches none', async () => {
    const { api } = await apiWith([
      route('GET', '/drive/v3/files', (url) =>
        url.searchParams.get('q')?.includes("'Q4'")
          ? files({ id: 'a'.repeat(20), name: 'Q4' }, { id: 'b'.repeat(20), name: 'Q4' })
          : files()
      )
    ])
    await expect(searchDrive(api, { in: 'Q4' })).rejects.toThrow('Several folders are named "Q4"')
    await expect(searchDrive(api, { in: 'Q5' })).rejects.toThrow('No folder named "Q5"')
  })
})

describe('Drive read', () => {
  it('reads a Doc as Markdown and pages a long one through the same text', async () => {
    const text = `# Plan\n${'x'.repeat(20_000)}`
    const { api, sent } = await apiWith([
      meta(file(DOC_ID, 'Plan', 'application/vnd.google-apps.document')),
      route('GET', `/drive/v3/files/${DOC_ID}/export`, () => bytesResponse(text, 'text/markdown'))
    ])
    const view = await readDrive(api, { ref: DOC_ID })
    expect(view.source).toBe('Doc as Markdown')
    expect(view.text.startsWith('# Plan')).toBe(true)
    expect(view.nextOffset).toBe(view.text.length)
    expect(view.part).toEqual({ from: 0, to: view.text.length, of: text.length })
    expect(sent[1]?.url.searchParams.get('mimeType')).toBe('text/markdown')
    // The next page continues the same text, converted once.
    const next = await readDrive(api, { ref: DOC_ID, offset: view.nextOffset })
    expect(view.text + next.text).toBe(text)
    expect(sent.filter((request) => request.url.pathname.endsWith('/export'))).toHaveLength(1)
  })

  it('reads every tab of a spreadsheet as a table', async () => {
    const { api } = await apiWith([
      meta(file(DOC_ID, 'Budget', 'application/vnd.google-apps.spreadsheet')),
      route('GET', `/v4/spreadsheets/${DOC_ID}`, () =>
        googleJson(200, {
          spreadsheetId: DOC_ID,
          properties: { title: 'Budget' },
          sheets: [{ properties: { title: 'Q3' } }, { properties: { title: "Ada's" } }]
        })
      ),
      route('GET', `/v4/spreadsheets/${DOC_ID}/values:batchGet`, (url) => {
        expect(url.searchParams.getAll('ranges')).toEqual(["'Q3'", "'Ada''s'"])
        return googleJson(200, {
          valueRanges: [
            {
              range: "'Q3'!A1:B2",
              values: [
                ['Item', 'Cost'],
                ['Pens', '4']
              ]
            },
            { range: "'Ada''s'!A1:Z1000" }
          ]
        })
      })
    ])
    const view = await readDrive(api, { ref: DOC_ID })
    expect(view.source).toBe('spreadsheet, 2 tabs')
    expect(view.text).toBe("## Q3\nrow | A | B\n1 | Item | Cost\n2 | Pens | 4\n\n## Ada's\n(empty)")
  })

  it('extracts a PDF’s text here, and sends a binary file to --download', async () => {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '4 0 obj<</Length 44>>stream',
      'BT /F1 18 Tf 20 100 Td (Hello PDF world) Tj ET',
      'endstream endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF'
    ].join('\n')
    const { api } = await apiWith([
      route('GET', `/drive/v3/files/${DOC_ID}`, (url) =>
        url.searchParams.get('alt') === 'media'
          ? bytesResponse(pdf, 'application/pdf')
          : googleJson(200, file(DOC_ID, 'Scan.pdf', 'application/pdf'))
      ),
      meta(file(FOLDER_ID, 'Photo.png', 'image/png'))
    ])
    const view = await readDrive(api, { ref: DOC_ID })
    expect(view.source).toBe('PDF text, 1 page')
    expect(view.text).toContain('Hello PDF world')
    await expect(readDrive(api, { ref: FOLDER_ID })).rejects.toThrow(
      `Save it with \`orca drive read ${FOLDER_ID} --download\``
    )
  })
})

describe('Drive writes', () => {
  it('downloads a Google file as its Office file, named so', async () => {
    const { api, sent } = await apiWith([
      meta(file(DOC_ID, 'Plan', 'application/vnd.google-apps.document')),
      route('GET', `/drive/v3/files/${DOC_ID}/export`, () => bytesResponse('PK', 'application/zip'))
    ])
    const saved = await downloadDrive(api, DOC_ID)
    expect(saved.name).toBe('Plan.docx')
    expect(Buffer.from(saved.data, 'base64').toString()).toBe('PK')
    expect(sent[1]?.url.searchParams.get('mimeType')).toContain('wordprocessingml')
  })

  it('uploads into a folder in one multipart request, converting when asked', async () => {
    const { api, writes } = await apiWith([
      route('POST', '/upload/drive/v3/files', () =>
        googleJson(200, file(DOC_ID, 'notes', 'application/vnd.google-apps.document'))
      ),
      route('GET', '/drive/v3/files', () => files({ id: FOLDER_ID, name: 'Q4' }))
    ])
    const view = await uploadDrive(api, {
      name: 'notes.md',
      data: Buffer.from('# Hi').toString('base64'),
      folder: 'Q4',
      convert: true,
      askedBy: 'asked by Carol via Ivy'
    })
    expect(view).toMatchObject({
      done: 'Uploaded and converted',
      folder: { id: FOLDER_ID, name: 'Q4' }
    })
    const upload = writes()[0]
    expect(upload?.url.searchParams.get('uploadType')).toBe('multipart')
    expect(upload?.raw).toContain(
      `{"name":"notes","mimeType":"application/vnd.google-apps.document","parents":["${FOLDER_ID}"],"description":"asked by Carol via Ivy"}`
    )
    expect(upload?.raw).toContain('Content-Type: text/markdown\r\n\r\n# Hi')
    await expect(uploadDrive(api, { name: 'photo.png', data: '', convert: true })).rejects.toThrow(
      'Only .docx'
    )
  })

  it('moves out of every old folder into the new one', async () => {
    const { api, writes } = await apiWith([
      route('GET', `/drive/v3/files/${DOC_ID}`, () =>
        googleJson(200, file(DOC_ID, 'Plan', 'application/pdf', { parents: ['oldA', 'oldB'] }))
      ),
      route('GET', `/drive/v3/files/${FOLDER_ID}`, () =>
        googleJson(200, file(FOLDER_ID, 'Q4', 'application/vnd.google-apps.folder'))
      ),
      route('PATCH', `/drive/v3/files/${DOC_ID}`, () =>
        googleJson(200, file(DOC_ID, 'Plan', 'application/pdf', { parents: [FOLDER_ID] }))
      )
    ])
    const view = await moveDrive(api, { ref: DOC_ID, folder: FOLDER_ID })
    expect(view).toMatchObject({ done: 'Moved', folder: { id: FOLDER_ID, name: 'Q4' } })
    expect(writes()[0]?.url.searchParams.get('addParents')).toBe(FOLDER_ID)
    expect(writes()[0]?.url.searchParams.get('removeParents')).toBe('oldA,oldB')
  })

  it('shares person by person and says who got access when one fails', async () => {
    const { api, writes } = await apiWith([
      meta(file(DOC_ID, 'Plan', 'application/pdf')),
      route('POST', `/drive/v3/files/${DOC_ID}/permissions`, (_url, body) =>
        JSON.stringify(body).includes('bad@')
          ? googleJson(400, { error: { code: 400, message: 'Invalid email' } })
          : googleJson(200, { id: 'p1' })
      )
    ])
    const view = await shareDrive(api, {
      ref: DOC_ID,
      with: ['sam@acme.dev'],
      role: 'commenter',
      askedBy: 'asked by Carol via Ivy'
    })
    expect(writes()[0]?.url.searchParams.get('emailMessage')).toBe('asked by Carol via Ivy')
    expect(view.done).toBe('sam@acme.dev can comment; Google emailed them')
    expect(writes()[0]?.body).toEqual({
      type: 'user',
      role: 'commenter',
      emailAddress: 'sam@acme.dev'
    })
    await expect(
      shareDrive(api, {
        ref: DOC_ID,
        with: ['sam@acme.dev', 'bad@x'],
        role: 'reader',
        notify: false
      })
    ).rejects.toThrow('Shared with sam@acme.dev; not with bad@x')
  })
})
