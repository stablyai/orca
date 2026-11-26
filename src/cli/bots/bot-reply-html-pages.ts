import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECTOR_REPLY_MAX_FILES } from '../../shared/connector-action-contract'
import { splitHtmlDocumentFences } from '../../shared/markdown/html-document-fences'
import type { LocalFile } from '../slack/slack-action-files'

// Names Windows reserves for devices, whatever the extension.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/

/** A page's file name from its title, never one an earlier page in the reply took. */
function htmlFileName(document: string, taken: Set<string>): string {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(document)?.[1] ?? ''
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const stem = !slug ? 'page' : WINDOWS_DEVICE_NAME.test(slug) ? `${slug}-page` : slug
  let name = `${stem}.html`
  for (let n = 2; taken.has(name); n++) {
    name = `${stem}-${n}.html`
  }
  taken.add(name)
  return name
}

/** Each whole HTML page in the text goes as an .html file (written to a temporary folder, removed
 *  after) with the words left around them as one post. Null when the pages can't go as files (too
 *  many, unwritable, or not staged): nothing has posted then, so the caller sends the words inline. */
export async function replyWithHtmlPages<T>(
  text: string,
  stage: (files: LocalFile[]) => Promise<string[]>,
  post: (staged: string[], rest: string | undefined) => Promise<T>
): Promise<{ files: number; sent: T } | null> {
  const split = splitHtmlDocumentFences(text)
  if (split.documents.length > CONNECTOR_REPLY_MAX_FILES) {
    return null
  }
  const staged = await stagePages(split.documents, stage).catch(() => null)
  return staged
    ? { files: split.documents.length, sent: await post(staged, split.text || undefined) }
    : null
}

async function stagePages(
  documents: string[],
  stage: (files: LocalFile[]) => Promise<string[]>
): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-reply-html-'))
  try {
    const files: LocalFile[] = []
    const taken = new Set<string>()
    for (const document of documents) {
      const name = htmlFileName(document, taken)
      const path = join(dir, name)
      await writeFile(path, document)
      files.push({ path, name, size: Buffer.byteLength(document) })
    }
    return await stage(files)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
