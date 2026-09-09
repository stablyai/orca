/**
 * Renders the committed fixtures with the real binary.
 *
 * Skipped where `officecli` is absent, because the alternative — a mocked spawn — would assert
 * that our argv is what we wrote, not that the tool answers it. The properties under test are all
 * properties of the tool's output, and only the tool can establish them.
 */
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { OFFICE_RENDER_MAX_BYTES } from '../../shared/office-preview-contracts'
import { probeOfficecli } from './office-probe-service'
import { renderOfficeDocument } from './office-render-service'

const FIXTURES = join(__dirname, '__fixtures__')

let installed = false

beforeAll(async () => {
  const probe = await probeOfficecli()
  installed = probe.ok && probe.installed
}, 30_000)

describe('office.render against real documents', () => {
  it.each(['sample.docx', 'sample.xlsx', 'sample.pptx', 'sample.docm'])(
    'renders %s to self-contained HTML',
    async (fixture) => {
      if (!installed) {
        return
      }
      const outcome = await renderOfficeDocument(join(FIXTURES, fixture))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) {
        return
      }
      expect(outcome.html).toContain('<html')
      expect(Buffer.byteLength(outcome.html, 'utf8')).toBeLessThan(OFFICE_RENDER_MAX_BYTES)

      // The single fact the snapshot path rests on: every asset is inline, so the document renders
      // under the preview partition's `img-src 'self' data:` CSP with nothing relaxed. If a future
      // officecli emits an external reference, this fails here rather than as a blank image in
      // front of a reader.
      const externalReferences = [...outcome.html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)]
        .map((match) => match[1])
        .filter(
          (reference) =>
            !reference.startsWith('data:') && !reference.startsWith('#') && reference !== ''
        )
      expect(externalReferences).toEqual([])
    },
    180_000
  )

  it('inlines an embedded image rather than referencing it', async () => {
    if (!installed) {
      return
    }
    const outcome = await renderOfficeDocument(join(FIXTURES, 'sample.pptx'))
    expect(outcome.ok && outcome.html.includes('data:image')).toBe(true)
  }, 180_000)

  it('renders a table in the Word fixture', async () => {
    if (!installed) {
      return
    }
    const outcome = await renderOfficeDocument(join(FIXTURES, 'sample.docx'))
    expect(outcome.ok && /<table/i.test(outcome.html)).toBe(true)
  }, 180_000)

  it('refuses a format it cannot render without blaming the toolchain', async () => {
    // No spawn happens at all: the extension table answers first, so a `.doc` never produces an
    // install prompt for a tool that was never the problem.
    const outcome = await renderOfficeDocument(join(FIXTURES, 'sample.doc'))
    expect(outcome).toEqual({ ok: false, code: 'OFFICECLI_UNSUPPORTED_FORMAT' })
  })

  it('reports a missing document as missing', async () => {
    if (!installed) {
      return
    }
    const outcome = await renderOfficeDocument(join(FIXTURES, 'absent.docx'))
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.code).toBe('OFFICECLI_FILE_NOT_FOUND')
  }, 60_000)
})
