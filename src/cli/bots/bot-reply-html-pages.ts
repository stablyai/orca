import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECTOR_REPLY_MAX_FILES } from '../../shared/connector-action-contract'
import { splitHtmlDocumentFences } from '../../shared/markdown/html-document-fences'
import { RuntimeClientError } from '../runtime/connection/types'
import type { LocalFile } from '../slack/slack-action-files'

/** The host's answer when a Slack reply's text holds a whole HTML page: it goes as an .html file. */
export const HTML_DOCUMENT_AS_FILE = 'html_document_as_file'

function htmlFileName(document: string, index: number): string {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(document)?.[1] ?? ''
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'page'}${index > 0 ? `-${index + 1}` : ''}.html`
}

/** Each whole HTML page in the text, written to a temporary .html file for `send`, with the words
 *  left around them; the files are removed once `send` settles. */
export async function withHtmlPageFiles<T>(
  text: string,
  send: (files: LocalFile[], text: string | undefined) => Promise<T>
): Promise<T> {
  const split = splitHtmlDocumentFences(text)
  if (split.documents.length > CONNECTOR_REPLY_MAX_FILES) {
    throw new RuntimeClientError(
      'invalid_argument',
      `A reply takes up to ${CONNECTOR_REPLY_MAX_FILES} HTML pages; send the rest in another reply.`
    )
  }
  const dir = await mkdtemp(join(tmpdir(), 'orca-reply-html-'))
  try {
    const files: LocalFile[] = []
    for (const [index, document] of split.documents.entries()) {
      const name = htmlFileName(document, index)
      const path = join(dir, name)
      await writeFile(path, document)
      files.push({ path, name, size: Buffer.byteLength(document) })
    }
    return await send(files, split.text || undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
