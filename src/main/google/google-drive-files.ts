// Drive files as the Drive, Docs and Sheets commands name them: an id or any Google link to one,
// a folder also by its name, and one summary shape for every answer.
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type { DriveFileSummary } from '../../shared/google/google-files-types'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'

export const DRIVE = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
export const FOLDER_TYPE = 'application/vnd.google-apps.folder'
export const DOC_TYPE = 'application/vnd.google-apps.document'
export const SHEET_TYPE = 'application/vnd.google-apps.spreadsheet'
export const SLIDES_TYPE = 'application/vnd.google-apps.presentation'
export const FILE_FIELDS =
  'id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),webViewLink,parents'

export const DriveFileSchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    modifiedTime: z.string().optional(),
    size: z.string().optional(),
    owners: z
      .array(z.object({ displayName: z.string().optional(), emailAddress: z.string().optional() }))
      .optional(),
    webViewLink: z.string().optional(),
    parents: z.array(z.string()).optional()
  })
)
export type DriveFile = z.infer<typeof DriveFileSchema>

// Drive ids are long; a short word is a folder's name, never an id.
const ID = /^[A-Za-z0-9_-]{19,}$/
const LINKED_ID = [
  /\/(?:document|spreadsheets|presentation|drawings|forms|file)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/,
  /\/folders\/([A-Za-z0-9_-]+)/,
  /[?&]id=([A-Za-z0-9_-]+)/
]

/** The id in a Drive, Docs or Sheets link, or the id itself; null for anything else. */
export function driveIdOf(ref: string): string | null {
  const trimmed = ref.trim()
  if (/^https:\/\/(docs|drive|sheets)\.google\.com\//.test(trimmed)) {
    for (const pattern of LINKED_ID) {
      const id = pattern.exec(trimmed)?.[1]
      if (id) {
        return id
      }
    }
    throw new GoogleToolError(
      'That Google link has no file id Orca can use. Use the id `orca drive search` prints.'
    )
  }
  return ID.test(trimmed) ? trimmed : null
}

/** A file's id from its id or link. */
export function requireDriveId(ref: string, what = 'file'): string {
  const id = driveIdOf(ref)
  if (!id) {
    throw new GoogleToolError(
      `"${ref.trim().slice(0, 80)}" isn't a Google ${what} id or link. \`orca drive search <words>\` finds one.`
    )
  }
  return id
}

export const driveQuoted = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** Drive's own options for files in shared drives too. */
export function allDrives(url: URL): URL {
  url.searchParams.set('supportsAllDrives', 'true')
  return url
}

export async function getDriveFile(api: GoogleApi, id: string): Promise<DriveFile> {
  const url = allDrives(new URL(`${DRIVE}/files/${encodeURIComponent(id)}`))
  url.searchParams.set('fields', FILE_FIELDS)
  const file = await api.find('drive', url.toString(), parseGoogleJson(DriveFileSchema))
  if (!file) {
    throw new GoogleToolError(
      `No Drive file ${id} that ${api.email} can see. Check the id, or whether it was shared with this account.`
    )
  }
  return file
}

/** A folder by id, link, name, or "root" for My Drive; a name matching several is refused. */
export async function resolveFolder(
  api: GoogleApi,
  ref: string
): Promise<{ id: string; name: string }> {
  const trimmed = ref.trim()
  if (/^(root|my drive)$/i.test(trimmed)) {
    return { id: 'root', name: 'My Drive' }
  }
  const id = driveIdOf(trimmed)
  if (id) {
    const file = await getDriveFile(api, id)
    if (file.mimeType !== FOLDER_TYPE) {
      throw new GoogleToolError(`${inlineName(file.name)} is a file, not a folder.`)
    }
    return { id: file.id, name: file.name }
  }
  const url = allDrives(new URL(`${DRIVE}/files`))
  url.searchParams.set(
    'q',
    `mimeType = '${FOLDER_TYPE}' and name = ${driveQuoted(trimmed)} and trashed = false`
  )
  url.searchParams.set('fields', 'files(id,name)')
  url.searchParams.set('pageSize', '5')
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  url.searchParams.set('corpora', 'allDrives')
  const found = await api.get(
    'drive',
    url.toString(),
    parseGoogleJson(
      z.object({ files: z.array(z.object({ id: z.string(), name: z.string() })).default([]) })
    )
  )
  const [only, ...others] = found.files
  if (!only) {
    throw new GoogleToolError(
      `No folder named "${inlineName(trimmed)}" in ${api.email}'s Drive. \`orca drive search\` finds it; \`orca drive mkdir\` makes one.`
    )
  }
  if (others.length > 0) {
    throw new GoogleToolError(
      `Several folders are named "${inlineName(trimmed)}": ${found.files.map((folder) => folder.id).join(', ')}. Pass the id.`
    )
  }
  return only
}

const inlineName = (name: string) => name.replace(/[\r\n"]+/g, ' ').slice(0, 120)

export function summarize(file: DriveFile): DriveFileSummary {
  const owner = file.owners?.[0]
  const modifiedAt = file.modifiedTime ? Date.parse(file.modifiedTime) : Number.NaN
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
    ...(file.size !== undefined && Number.isFinite(Number(file.size))
      ? { size: Number(file.size) }
      : {}),
    ...(owner ? { owner: owner.emailAddress ?? owner.displayName ?? '' } : {}),
    ...(file.webViewLink ? { link: file.webViewLink } : {})
  }
}

/** One multipart body: the file's details as JSON, then its bytes. */
export function multipart(
  metadata: Record<string, unknown>,
  media: { body: Buffer; contentType: string }
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `orca-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const head = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${media.contentType}`,
    '',
    ''
  ].join('\r\n')
  return {
    body: new Uint8Array(
      Buffer.concat([Buffer.from(head), media.body, Buffer.from(`\r\n--${boundary}--`)])
    ),
    contentType: `multipart/related; boundary=${boundary}`
  }
}

/** Google files saved as the Office or image file a person would download. */
export const EXPORTS: Record<string, { type: string; extension: string }> = {
  [DOC_TYPE]: {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx'
  },
  [SHEET_TYPE]: {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx'
  },
  [SLIDES_TYPE]: {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx'
  },
  'application/vnd.google-apps.drawing': { type: 'image/png', extension: 'png' }
}

export const fileUrl = (id: string, suffix = '') =>
  allDrives(new URL(`${DRIVE}/files/${encodeURIComponent(id)}${suffix}`))
