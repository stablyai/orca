// `orca drive read`: any Drive file as text where Orca can make it (Docs as Markdown, Sheets tab by
// tab, Slides as text, PDFs read off the main thread), paged, or the file itself to save.
import type { DriveDownload, DriveReadView } from '../../shared/google/google-files-types'
import { sheetTable, splitA1 } from '../../shared/google/sheets-a1'
import { pageOfText } from '../../shared/tool-output-limits'
import { GoogleToolError, type GoogleApi } from './google-api-client'
import {
  DOC_TYPE,
  DRIVE,
  type DriveFile,
  EXPORTS,
  fileUrl,
  FOLDER_TYPE,
  getDriveFile,
  requireDriveId,
  SHEET_TYPE,
  SLIDES_TYPE,
  summarize
} from './google-drive-files'
import { cachedFileText } from './google-drive-text-cache'
import { pdfTextViaWorker } from './google-pdf-text-client'
import { readAllTabs } from './google-sheets'

// Google's own cap on an export; read here, only the text's pages go back.
const DRIVE_READ_MAX_BYTES = 10 * 1024 * 1024
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|sql))/

function exportUrl(id: string, type: string): string {
  const url = new URL(`${DRIVE}/files/${encodeURIComponent(id)}/export`)
  url.searchParams.set('mimeType', type)
  return url.toString()
}

function mediaUrl(id: string): string {
  const url = fileUrl(id)
  url.searchParams.set('alt', 'media')
  return url.toString()
}

async function fileText(
  api: GoogleApi,
  file: DriveFile
): Promise<{ text: string; source: string }> {
  const bytes = async (url: string) => ({
    data: Buffer.from(await api.bytes('drive', url, DRIVE_READ_MAX_BYTES))
  })
  if (file.mimeType === DOC_TYPE) {
    const { data } = await bytes(exportUrl(file.id, 'text/markdown'))
    return { text: data.toString('utf8'), source: 'Doc as Markdown' }
  }
  if (file.mimeType === SHEET_TYPE) {
    const sheet = await readAllTabs(api, file.id)
    const text = sheet.tabs
      .map((tab) => {
        const origin = splitA1(tab.range)
        return `## ${tab.title}\n${tab.values.length ? sheetTable(tab.values, origin) : '(empty)'}`
      })
      .join('\n\n')
    return {
      text,
      source: `spreadsheet, ${sheet.tabs.length} tab${sheet.tabs.length === 1 ? '' : 's'}`
    }
  }
  if (file.mimeType === SLIDES_TYPE) {
    const { data } = await bytes(exportUrl(file.id, 'text/plain'))
    return { text: data.toString('utf8'), source: 'slides as text' }
  }
  if (file.mimeType === 'application/pdf') {
    const { data } = await bytes(mediaUrl(file.id))
    const pdf = await pdfTextViaWorker(new Uint8Array(data)).catch(() => {
      throw new GoogleToolError(
        "Orca couldn't read text from this PDF. Save it with --download instead."
      )
    })
    return { text: pdf.text, source: `PDF text, ${pdf.pages} page${pdf.pages === 1 ? '' : 's'}` }
  }
  if (TEXT_TYPES.test(file.mimeType)) {
    const { data } = await bytes(mediaUrl(file.id))
    return { text: data.toString('utf8'), source: file.mimeType }
  }
  throw new GoogleToolError(
    file.mimeType === FOLDER_TYPE
      ? 'That is a folder. `orca drive list <folder>` shows what is in it.'
      : `Orca can't show a ${file.mimeType} file as text. Save it with \`orca drive read ${file.id} --download\`.`
  )
}

export async function readDrive(
  api: GoogleApi,
  args: { ref: string; offset?: number }
): Promise<DriveReadView> {
  const file = await getDriveFile(api, requireDriveId(args.ref))
  const { text, source } = await cachedFileText(
    {
      account: api.email,
      id: file.id,
      ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {})
    },
    () => fileText(api, file)
  )
  const page = pageOfText(text, args.offset)
  return {
    account: api.email,
    file: summarize(file),
    source,
    text: page.text,
    ...(page.nextOffset !== undefined || (args.offset ?? 0) > 0
      ? {
          part: {
            from: Math.min(args.offset ?? 0, text.length),
            to: page.nextOffset ?? text.length,
            of: text.length
          }
        }
      : {}),
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {})
  }
}

export async function downloadDrive(api: GoogleApi, ref: string): Promise<DriveDownload> {
  const file = await getDriveFile(api, requireDriveId(ref))
  const exported = EXPORTS[file.mimeType]
  if (!exported && file.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new GoogleToolError(`Google can't save a ${file.mimeType} file as a download.`)
  }
  // The file itself goes back in the answer, so the answer's own cap applies.
  const data = Buffer.from(
    await api.bytes('drive', exported ? exportUrl(file.id, exported.type) : mediaUrl(file.id))
  )
  const name =
    exported && !file.name.toLowerCase().endsWith(`.${exported.extension}`)
      ? `${file.name}.${exported.extension}`
      : file.name
  return { file: summarize(file), name, data: data.toString('base64') }
}
