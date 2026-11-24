// `orca docs read|create|append|replace|comment`. Edits name exact text, never positions: Orca
// finds the text in a fresh read and refuses an edit whose text isn't there exactly once (unless
// --all). With --suggest, edits land as suggestions the doc's owner accepts or rejects in Docs.
import { z } from 'zod'
import type { DocsReadView, DocsWriteView } from '../../shared/google/google-files-types'
import { pageOfText } from '../../shared/tool-output-limits'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import { appendRequests } from './google-docs-markdown'
import { commentsInBudget, openComments } from './google-docs-comments'
import {
  documentTexts,
  DocumentSchema,
  findInDocument,
  renderDocument,
  type GoogleDocument
} from './google-docs-text'
import {
  allDrives,
  DOC_TYPE,
  DRIVE,
  DRIVE_UPLOAD,
  DriveFileSchema,
  multipart,
  requireDriveId,
  resolveFolder
} from './google-drive-files'

const DOCS = 'https://docs.googleapis.com/v1/documents'
// Docs' line break inside a paragraph (Shift+Enter).
const VERTICAL_TAB = String.fromCharCode(11)

const docLink = (id: string) => `https://docs.google.com/document/d/${id}/edit`

async function getDocument(api: GoogleApi, ref: string): Promise<GoogleDocument> {
  const id = requireDriveId(ref, 'doc')
  const url = new URL(`${DOCS}/${encodeURIComponent(id)}`)
  url.searchParams.set('includeTabsContent', 'true')
  url.searchParams.set('suggestionsViewMode', 'SUGGESTIONS_INLINE')
  const doc = await api.find('docs', url.toString(), parseGoogleJson(DocumentSchema))
  if (!doc) {
    throw new GoogleToolError(`No doc ${id} that ${api.email} can see.`)
  }
  return doc
}

export async function readDoc(
  api: GoogleApi,
  args: { ref: string; offset?: number }
): Promise<DocsReadView> {
  const doc = await getDocument(api, args.ref)
  const [rendered, comments] = await Promise.all([
    Promise.resolve(renderDocument(doc)),
    openComments(api, doc.documentId)
  ])
  const page = pageOfText(rendered.text, args.offset)
  return {
    account: api.email,
    id: doc.documentId,
    title: doc.title,
    link: docLink(doc.documentId),
    text: page.text,
    ...(page.nextOffset !== undefined || (args.offset ?? 0) > 0
      ? {
          part: {
            from: Math.min(args.offset ?? 0, page.total),
            to: page.nextOffset ?? page.total,
            of: page.total
          }
        }
      : {}),
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    suggestions: rendered.suggestions,
    // Later pages repeat no comments: the first page already showed what fits.
    comments: (args.offset ?? 0) > 0 ? [] : commentsInBudget(comments),
    openComments: comments.length
  }
}

/** A new doc from Markdown, through Drive's own Markdown import. */
export async function createDoc(
  api: GoogleApi,
  args: { title: string; markdown: string; folder?: string; askedBy?: string | null }
): Promise<DocsWriteView> {
  const folder = args.folder ? await resolveFolder(api, args.folder) : undefined
  const url = allDrives(new URL(`${DRIVE_UPLOAD}/files`))
  url.searchParams.set('uploadType', 'multipart')
  url.searchParams.set('fields', 'id,name,webViewLink')
  const file = await api.send(
    'drive',
    {
      method: 'POST',
      url: url.toString(),
      raw: multipart(
        {
          name: args.title,
          mimeType: DOC_TYPE,
          ...(folder ? { parents: [folder.id] } : {}),
          ...(args.askedBy ? { description: args.askedBy } : {})
        },
        { body: Buffer.from(args.markdown, 'utf8'), contentType: 'text/markdown' }
      )
    },
    parseGoogleJson(DriveFileSchema)
  )
  return {
    account: api.email,
    id: file.id,
    title: file.name,
    link: file.webViewLink ?? docLink(file.id),
    done: 'Created',
    ...(folder ? { folder } : {})
  }
}

const BatchSchema = z.object({
  replies: z
    .array(
      z.object({
        replaceAllText: z.object({ occurrencesChanged: z.number().optional() }).optional()
      })
    )
    .default([]),
  // A comment request answers 200 even when Google didn't keep the comment; this says which.
  commentUpdateState: z.string().optional()
})

async function batchUpdate(api: GoogleApi, id: string, requests: unknown[], suggest = false) {
  return api.send(
    'docs',
    {
      method: 'POST',
      url: `${DOCS}/${encodeURIComponent(id)}:batchUpdate`,
      json: { requests, ...(suggest ? { writeControl: { writeMode: 'SUGGEST' } } : {}) }
    },
    parseGoogleJson(BatchSchema)
  )
}

/** Markdown added at the end of the doc's first tab, as a new paragraph. */
export async function appendDoc(
  api: GoogleApi,
  args: { ref: string; markdown: string }
): Promise<DocsWriteView> {
  const doc = await getDocument(api, args.ref)
  const first = doc.tabs[0]
  const content = (first ? first.documentTab?.body : doc.body)?.content ?? []
  const last = content.at(-1)
  // The body always ends with a newline; new text goes just before it.
  const endIndex = last?.endIndex ?? 2
  const lastText = (last?.paragraph?.elements ?? [])
    .map((part) => part.textRun?.content ?? '')
    .join('')
  const tabId = first?.tabProperties?.tabId
  const requests = appendRequests(args.markdown, endIndex - 1, lastText.trim().length > 0).map(
    (request) => withTab(request, tabId)
  )
  await batchUpdate(api, doc.documentId, requests)
  return written(api, doc, 'Added to the end')
}

/** Every range and location in a request, pointed at one tab. */
function withTab(request: unknown, tabId: string | undefined): unknown {
  if (!tabId || typeof request !== 'object' || request === null) {
    return request
  }
  return Object.fromEntries(
    Object.entries(request).map(([key, value]) =>
      (key === 'range' || key === 'location') && typeof value === 'object' && value !== null
        ? [key, { ...value, tabId }]
        : [key, typeof value === 'object' ? withTab(value, tabId) : value]
    )
  )
}

export type ReplacePair = { old: string; new: string }

/** Exact find-and-replace in one atomic edit, after checking every old text matches as asked. */
export async function replaceInDoc(
  api: GoogleApi,
  args: { ref: string; pairs: ReplacePair[]; suggest?: boolean; all?: boolean; matchCase?: boolean }
): Promise<DocsWriteView> {
  const doc = await getDocument(api, args.ref)
  const texts = documentTexts(doc)
  const problems: string[] = []
  for (const [index, pair] of args.pairs.entries()) {
    const label =
      args.pairs.length > 1 ? `Pair ${index + 1} ("${short(pair.old)}")` : `"${short(pair.old)}"`
    if (pair.old.includes('\n') || pair.old.includes(VERTICAL_TAB)) {
      problems.push(`${label} spans a line break; replace one paragraph at a time.`)
      continue
    }
    const count = findInDocument(texts, pair.old, args.matchCase === true).length
    if (count === 0) {
      problems.push(`${label} isn't in the doc. Copy it exactly from \`orca docs read\`.`)
    } else if (count > 1 && !args.all) {
      problems.push(
        `${label} is in the doc ${count} times. Quote more of the text around it, or pass --all.`
      )
    }
  }
  if (problems.length > 0) {
    throw new GoogleToolError(`Nothing changed. ${problems.join(' ')}`)
  }
  const answer = await batchUpdate(
    api,
    doc.documentId,
    args.pairs.map((pair) => ({
      replaceAllText: {
        containsText: { text: pair.old, matchCase: args.matchCase === true },
        replaceText: pair.new
      }
    })),
    args.suggest === true
  )
  const changed = answer.replies.reduce(
    (sum, reply) => sum + (reply.replaceAllText?.occurrencesChanged ?? 0),
    0
  )
  return written(
    api,
    doc,
    `${args.suggest ? 'Suggested' : 'Made'} ${changed} change${changed === 1 ? '' : 's'}${args.suggest ? '; the owner accepts or rejects them in Docs' : ''}`
  )
}

/** A comment on the doc, anchored to the quoted text when `on` is given. */
export async function commentOnDoc(
  api: GoogleApi,
  args: { ref: string; text: string; on?: string }
): Promise<DocsWriteView> {
  const doc = await getDocument(api, args.ref)
  if (!args.on) {
    const url = allDrives(new URL(`${DRIVE}/files/${encodeURIComponent(doc.documentId)}/comments`))
    url.searchParams.set('fields', 'id')
    await api.send(
      'drive',
      { method: 'POST', url: url.toString(), json: { content: args.text } },
      parseGoogleJson(z.object({ id: z.string() }))
    )
    return written(api, doc, 'Commented on the doc')
  }
  const found = findInDocument(
    documentTexts(doc).filter((text) => text.body),
    args.on,
    true
  )
  const [only] = found
  if (!only || found.length > 1) {
    throw new GoogleToolError(
      found.length === 0
        ? `"${short(args.on)}" isn't in the doc. Copy it exactly from \`orca docs read\`.`
        : `"${short(args.on)}" is in the doc ${found.length} times. Quote more of the text around it.`
    )
  }
  const startIndex = only.text.at[only.start] ?? 0
  const endIndex = (only.text.at[only.start + args.on.length - 1] ?? startIndex) + 1
  const answer = await batchUpdate(api, doc.documentId, [
    {
      insertComment: {
        content: args.text,
        range: { startIndex, endIndex, ...(only.text.tabId ? { tabId: only.text.tabId } : {}) }
      }
    }
  ])
  if (answer.commentUpdateState !== 'ALL_SAVED') {
    throw new GoogleToolError(
      `Google didn't save the comment (${answer.commentUpdateState ?? 'no answer'}). Try again.`
    )
  }
  return written(api, doc, 'Commented on the quoted text')
}

const short = (text: string) => text.replace(/\s+/g, ' ').slice(0, 60)

const written = (api: GoogleApi, doc: GoogleDocument, done: string): DocsWriteView => ({
  account: api.email,
  id: doc.documentId,
  title: doc.title,
  link: docLink(doc.documentId),
  done
})
