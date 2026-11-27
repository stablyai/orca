// `orca drive search|list|upload|mkdir|move|share`: finding files and filing them. Uploads are
// capped to what one request carries. No delete: nothing here can lose a file.
import type { DriveListView, DriveWriteView } from '../../shared/google/google-files-types'
import { formatMegabytes, TOOL_LIST_PAGE_SIZE } from '../../shared/tool-output-limits'
import { DRIVE_UPLOAD_MAX_BYTES } from '../../shared/rpc-contract/google-files-params'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import {
  allDrives,
  DOC_TYPE,
  DRIVE,
  DRIVE_UPLOAD,
  DriveFileSchema,
  driveQuoted,
  EXPORTS,
  FILE_FIELDS,
  fileUrl,
  FOLDER_TYPE,
  getDriveFile,
  multipart,
  requireDriveId,
  resolveFolder,
  SHEET_TYPE,
  SLIDES_TYPE,
  summarize
} from './google-drive-files'

const ListSchema = lazyZodSchema(() =>
  z.object({
    files: z.array(DriveFileSchema).default([]),
    nextPageToken: z.string().optional()
  })
)

export async function searchDrive(
  api: GoogleApi,
  args: { query?: string; in?: string; pageToken?: string; limit?: number }
): Promise<DriveListView> {
  const folder = args.in ? await resolveFolder(api, args.in) : undefined
  const words = args.query?.trim()
  const terms = [
    ...(words
      ? [`(name contains ${driveQuoted(words)} or fullText contains ${driveQuoted(words)})`]
      : []),
    ...(folder ? [`${driveQuoted(folder.id)} in parents`] : []),
    'trashed = false'
  ]
  const url = allDrives(new URL(`${DRIVE}/files`))
  url.searchParams.set('q', terms.join(' and '))
  url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`)
  url.searchParams.set('pageSize', String(args.limit ?? TOOL_LIST_PAGE_SIZE))
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  url.searchParams.set('corpora', 'allDrives')
  // Full-text results come by relevance; a folder or recent list reads best newest first.
  if (!words) {
    url.searchParams.set('orderBy', folder ? 'folder,name' : 'modifiedTime desc')
  }
  if (args.pageToken) {
    url.searchParams.set('pageToken', args.pageToken)
  }
  const list = await api.get('drive', url.toString(), parseGoogleJson(ListSchema))
  return {
    account: api.email,
    ...(folder ? { folder } : {}),
    files: list.files.map(summarize),
    ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {})
  }
}

const UPLOAD_TYPES: Record<string, { type: string; convertTo?: string }> = {
  pdf: { type: 'application/pdf' },
  txt: { type: 'text/plain', convertTo: DOC_TYPE },
  md: { type: 'text/markdown', convertTo: DOC_TYPE },
  html: { type: 'text/html', convertTo: DOC_TYPE },
  docx: { type: EXPORTS[DOC_TYPE]?.type ?? '', convertTo: DOC_TYPE },
  csv: { type: 'text/csv', convertTo: SHEET_TYPE },
  xlsx: { type: EXPORTS[SHEET_TYPE]?.type ?? '', convertTo: SHEET_TYPE },
  pptx: { type: EXPORTS[SLIDES_TYPE]?.type ?? '', convertTo: SLIDES_TYPE },
  png: { type: 'image/png' },
  jpg: { type: 'image/jpeg' },
  jpeg: { type: 'image/jpeg' },
  json: { type: 'application/json' },
  zip: { type: 'application/zip' }
}

export async function uploadDrive(
  api: GoogleApi,
  args: { name: string; data: string; folder?: string; convert?: boolean; askedBy?: string | null }
): Promise<DriveWriteView> {
  const body = Buffer.from(args.data, 'base64')
  if (body.length > DRIVE_UPLOAD_MAX_BYTES) {
    throw new GoogleToolError(
      `Upload takes files up to ${formatMegabytes(DRIVE_UPLOAD_MAX_BYTES)}.`
    )
  }
  const extension = /\.([A-Za-z0-9]+)$/.exec(args.name)?.[1]?.toLowerCase() ?? ''
  const known = UPLOAD_TYPES[extension]
  if (args.convert && !known?.convertTo) {
    throw new GoogleToolError(
      'Only .docx, .txt, .md, .html (to a Doc), .csv, .xlsx (to a Sheet) and .pptx convert.'
    )
  }
  const folder = args.folder ? await resolveFolder(api, args.folder) : undefined
  const name = args.convert ? args.name.replace(/\.[A-Za-z0-9]+$/, '') : args.name
  const upload = multipart(
    {
      name,
      ...(args.convert && known?.convertTo ? { mimeType: known.convertTo } : {}),
      ...(folder ? { parents: [folder.id] } : {}),
      ...(args.askedBy ? { description: args.askedBy } : {})
    },
    { body, contentType: known?.type || 'application/octet-stream' }
  )
  const url = allDrives(new URL(`${DRIVE_UPLOAD}/files`))
  url.searchParams.set('uploadType', 'multipart')
  url.searchParams.set('fields', FILE_FIELDS)
  const file = await api.send(
    'drive',
    { method: 'POST', url: url.toString(), raw: upload },
    parseGoogleJson(DriveFileSchema)
  )
  return {
    account: api.email,
    file: summarize(file),
    done: args.convert ? 'Uploaded and converted' : 'Uploaded',
    ...(folder ? { folder } : {})
  }
}

export async function makeFolder(
  api: GoogleApi,
  args: { name: string; in?: string; askedBy?: string | null }
): Promise<DriveWriteView> {
  const parent = args.in ? await resolveFolder(api, args.in) : undefined
  const url = allDrives(new URL(`${DRIVE}/files`))
  url.searchParams.set('fields', FILE_FIELDS)
  const file = await api.send(
    'drive',
    {
      method: 'POST',
      url: url.toString(),
      json: {
        name: args.name,
        mimeType: FOLDER_TYPE,
        ...(parent ? { parents: [parent.id] } : {}),
        ...(args.askedBy ? { description: args.askedBy } : {})
      }
    },
    parseGoogleJson(DriveFileSchema)
  )
  return {
    account: api.email,
    file: summarize(file),
    done: 'Made folder',
    ...(parent ? { folder: parent } : {})
  }
}

export async function moveDrive(
  api: GoogleApi,
  args: { ref: string; folder: string }
): Promise<DriveWriteView> {
  const file = await getDriveFile(api, requireDriveId(args.ref))
  const folder = await resolveFolder(api, args.folder)
  const url = fileUrl(file.id)
  url.searchParams.set('addParents', folder.id)
  const from = (file.parents ?? []).filter((parent) => parent !== folder.id)
  if (from.length > 0) {
    url.searchParams.set('removeParents', from.join(','))
  }
  url.searchParams.set('fields', FILE_FIELDS)
  const moved = await api.send(
    'drive',
    { method: 'PATCH', url: url.toString(), json: {} },
    parseGoogleJson(DriveFileSchema)
  )
  return { account: api.email, file: summarize(moved), done: 'Moved', folder }
}

export async function shareDrive(
  api: GoogleApi,
  args: {
    ref: string
    with: string[]
    role: 'reader' | 'commenter' | 'writer'
    notify?: boolean
    askedBy?: string | null
  }
): Promise<DriveWriteView> {
  const file = await getDriveFile(api, requireDriveId(args.ref))
  const shared: string[] = []
  for (const email of args.with) {
    const url = fileUrl(file.id, '/permissions')
    url.searchParams.set('sendNotificationEmail', String(args.notify !== false))
    // The invite email says who asked, as Google's own share dialog lets a person add a note.
    if (args.notify !== false && args.askedBy) {
      url.searchParams.set('emailMessage', args.askedBy)
    }
    try {
      await api.send(
        'drive',
        {
          method: 'POST',
          url: url.toString(),
          json: { type: 'user', role: args.role, emailAddress: email }
        },
        parseGoogleJson(z.object({ id: z.string() }))
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new GoogleToolError(
        `${shared.length ? `Shared with ${shared.join(', ')}; ` : ''}not with ${email}: ${reason}`
      )
    }
    shared.push(email)
  }
  const can = { reader: 'view', commenter: 'comment', writer: 'edit' }[args.role]
  return {
    account: api.email,
    file: summarize(file),
    done: `${shared.join(', ')} can ${can}${args.notify === false ? '' : '; Google emailed them'}`
  }
}
