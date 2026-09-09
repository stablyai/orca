import { afterEach, describe, expect, it } from 'vitest'
import {
  authorizeDocPreviewDirectory,
  getDocPreviewGrant,
  INLINE_DOC_PREVIEW_ENTRY,
  mintInlineDocPreviewGrant,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant
} from './doc-preview-grant-registry'
import { readDocPreviewFile } from './doc-preview-file-reader'

const HTML = '<!doctype html><p>rendered</p>'

function mint(): ReturnType<typeof mintInlineDocPreviewGrant> {
  return mintInlineDocPreviewGrant({
    documents: new Map([
      [
        INLINE_DOC_PREVIEW_ENTRY,
        { bytes: Buffer.from(HTML, 'utf8'), contentType: 'text/html; charset=utf-8' }
      ]
    ]),
    browserPageId: 'page-1'
  })
}

afterEach(() => revokeAllDocPreviewGrants())

describe('inline document preview grants', () => {
  it('serves the bytes main already holds', async () => {
    const grant = mint()
    const outcome = await readDocPreviewFile(grant, INLINE_DOC_PREVIEW_ENTRY)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.bytes.toString('utf8')).toBe(HTML)
    expect(outcome.ok && outcome.contentType).toBe('text/html; charset=utf-8')
  })

  it('answers an empty request with the entry document', async () => {
    // The protocol handler substitutes the entry path for a bare `orca-preview://<grant>/`.
    const grant = mint()
    const outcome = await readDocPreviewFile(grant, grant.entryRelativePath)
    expect(outcome.ok).toBe(true)
  })

  it('reads nothing that is not in the map', async () => {
    const grant = mint()
    for (const path of ['other.html', '../secrets.env', 'assets/logo.png']) {
      const outcome = await readDocPreviewFile(grant, path)
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.status).toBe(404)
    }
  })

  it('normalizes slash variants onto the one key', async () => {
    const grant = mint()
    for (const path of [`/${INLINE_DOC_PREVIEW_ENTRY}`, `\\${INLINE_DOC_PREVIEW_ENTRY}`]) {
      const outcome = await readDocPreviewFile(grant, path)
      expect(outcome.ok).toBe(true)
    }
  })

  it('refuses to widen onto a directory, because it has none', () => {
    const grant = mint()
    expect(authorizeDocPreviewDirectory(grant.id, INLINE_DOC_PREVIEW_ENTRY)).toBe(false)
  })

  it('stops answering once revoked', async () => {
    const grant = mint()
    expect(revokeDocPreviewGrant(grant.id)).toBe(true)
    expect(getDocPreviewGrant(grant.id)).toBeNull()
    // The grant object still exists in this test's hand; what is gone is the registry entry the
    // protocol handler resolves, which is the only way a request can reach these bytes.
    expect(revokeDocPreviewGrant(grant.id)).toBe(false)
  })
})
