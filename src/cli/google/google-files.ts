// `orca drive|docs|sheets`: Drive, Docs and Sheets as the Google account the host has connected;
// this reads the command's files and text here and prints the host's answer.
import { basename } from 'node:path'
import type {
  DocsReadView,
  DocsWriteView,
  DriveDownload,
  DriveListView,
  DriveReadView,
  DriveWriteView,
  SheetsReadView,
  SheetsWriteView
} from '../../shared/google/google-files-types'
import { DRIVE_UPLOAD_MAX_BYTES } from '../../shared/rpc-contract/google-files-params'
import { readTextOrFileFlag } from '../arguments/command-body-input'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import {
  formatDocsRead,
  formatDocsWrite,
  formatDriveList,
  formatDriveRead,
  formatDriveWrite,
  formatSheetsRead,
  formatSheetsWrite
} from './google-files-format'
import { RuntimeClientError } from '../runtime/connection/types'
import { callGoogle, googleCallParams } from './google-call'
import { attachedFile, refuseForwardedShell, saveDownload } from '../slack/slack-action-files'

type Flags = HandlerContext['flags']

/** The named flags that were given, by the RPC's names for them. */
function optional(flags: Flags, names: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(names).flatMap(([flag, param]) => {
      const value = getOptionalStringFlag(flags, flag)
      return value ? [[param, value]] : []
    })
  )
}

const on = (flags: Flags, name: string) => (flags.get(name) === true ? { [name]: true } : {})

function invalid(message: string): never {
  throw new RuntimeClientError('invalid_argument', message)
}

async function body(flags: Flags, cwd: string): Promise<string> {
  return (await readTextOrFileFlag(flags, cwd, 'body', true)) ?? ''
}

async function values(flags: Flags, cwd: string): Promise<unknown[][]> {
  const text = (await readTextOrFileFlag(flags, cwd, 'values', true)) ?? ''
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return invalid('--values must be JSON: an array of rows, e.g. [["Ada",42]].')
    }
  })()
  if (!Array.isArray(parsed) || !parsed.every((row) => Array.isArray(row))) {
    invalid(
      '--values must be an array of rows, e.g. [["Ada",42]]; one row is [["Ada",42]], not ["Ada",42].'
    )
  }
  return parsed
}

async function pairs(flags: Flags, cwd: string) {
  if (flags.has('pairs-file')) {
    if (flags.has('old') || flags.has('new')) {
      invalid('Give either "<old>" "<new>" or --pairs-file, not both.')
    }
    const text = (await readTextOrFileFlag(flags, cwd, 'pairs', true)) ?? ''
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      // Falls through to the shape hint.
    }
    return invalid('--pairs-file must be a JSON list like [{"old":"teh","new":"the"}].')
  }
  const replacement = flags.get('new')
  if (typeof replacement !== 'string') {
    invalid('Give the exact old text and the new text: orca docs replace <doc> "<old>" "<new>".')
  }
  return [{ old: getRequiredStringFlag(flags, 'old'), new: replacement }]
}

const sheetValues = async (flags: Flags, cwd: string) => ({
  ...googleCallParams(flags),
  ref: getRequiredStringFlag(flags, 'ref'),
  ...optional(flags, { tab: 'tab' }),
  values: await values(flags, cwd),
  ...on(flags, 'formulas')
})

export const GOOGLE_FILES_HANDLERS: Record<string, CommandHandler> = {
  'drive search': async ({ flags, client, json }) => {
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const query = getOptionalStringFlag(flags, 'query')
    const result = await callGoogle<DriveListView>(client, 'google.drive.search', {
      ...googleCallParams(flags),
      ...optional(flags, { query: 'query', in: 'in', page: 'pageToken' }),
      ...(limit !== undefined ? { limit } : {})
    })
    const inFolder = getOptionalStringFlag(flags, 'in')
    const again = [
      'orca drive search',
      ...(query ? [JSON.stringify(query)] : []),
      ...(inFolder ? [`--in ${JSON.stringify(inFolder)}`] : [])
    ]
    printResult(result, json, (view) => formatDriveList(view, again.join(' ')))
  },
  'drive list': async ({ flags, client, json }) => {
    const folder = getRequiredStringFlag(flags, 'folder')
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const result = await callGoogle<DriveListView>(client, 'google.drive.list', {
      ...googleCallParams(flags),
      folder,
      ...optional(flags, { page: 'pageToken' }),
      ...(limit !== undefined ? { limit } : {})
    })
    printResult(result, json, (view) =>
      formatDriveList(view, `orca drive list ${JSON.stringify(folder)}`)
    )
  },
  'drive read': async ({ flags, client, json, cwd }) => {
    // `--download <file>`, as gmail and slack read take it; a bare --download after the file works too.
    const download = flags.get('download')
    if (download !== undefined) {
      refuseForwardedShell()
      const result = await callGoogle<DriveDownload>(client, 'google.drive.download', {
        ...googleCallParams(flags),
        ref: typeof download === 'string' ? download : getRequiredStringFlag(flags, 'ref')
      })
      const { data, ...file } = result.result
      const savedTo = await saveDownload(cwd, getOptionalStringFlag(flags, 'out'), {
        id: file.file.id,
        name: file.name,
        data
      })
      printResult(
        { ...result, result: { ...file, savedTo } },
        json,
        () => `Saved ${file.name} to ${savedTo}`
      )
      return
    }
    const ref = getRequiredStringFlag(flags, 'ref')
    const offset = getOptionalNonNegativeIntegerFlag(flags, 'offset')
    const result = await callGoogle<DriveReadView>(client, 'google.drive.read', {
      ...googleCallParams(flags),
      ref,
      ...(offset !== undefined ? { offset } : {})
    })
    printResult(result, json, formatDriveRead)
  },
  'drive upload': async ({ flags, client, json, cwd }) => {
    const file = await attachedFile(cwd, getRequiredStringFlag(flags, 'path'), {
      maxBytes: DRIVE_UPLOAD_MAX_BYTES,
      verb: 'upload'
    })
    const result = await callGoogle<DriveWriteView>(client, 'google.drive.upload', {
      ...googleCallParams(flags),
      name: basename(file.name),
      data: file.data,
      ...optional(flags, { folder: 'folder' }),
      ...on(flags, 'convert')
    })
    printResult(result, json, formatDriveWrite)
  },
  'drive mkdir': async ({ flags, client, json }) => {
    const result = await callGoogle<DriveWriteView>(client, 'google.drive.mkdir', {
      ...googleCallParams(flags),
      name: getRequiredStringFlag(flags, 'name'),
      ...optional(flags, { in: 'in' })
    })
    printResult(result, json, formatDriveWrite)
  },
  'drive move': async ({ flags, client, json }) => {
    const result = await callGoogle<DriveWriteView>(client, 'google.drive.move', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref'),
      folder: getRequiredStringFlag(flags, 'folder')
    })
    printResult(result, json, formatDriveWrite)
  },
  'drive share': async ({ flags, client, json }) => {
    const people = getRequiredStringFlag(flags, 'with')
      .split(/[\s,]+/)
      .filter(Boolean)
    const result = await callGoogle<DriveWriteView>(client, 'google.drive.share', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref'),
      with: people,
      role: getOptionalStringFlag(flags, 'role') ?? 'reader',
      ...(flags.get('no-notify') === true ? { notify: false } : {})
    })
    printResult(result, json, formatDriveWrite)
  },
  'docs read': async ({ flags, client, json }) => {
    const offset = getOptionalNonNegativeIntegerFlag(flags, 'offset')
    const result = await callGoogle<DocsReadView>(client, 'google.docs.read', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref'),
      ...(offset !== undefined ? { offset } : {})
    })
    printResult(result, json, formatDocsRead)
  },
  'docs create': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<DocsWriteView>(client, 'google.docs.create', {
      ...googleCallParams(flags),
      title: getRequiredStringFlag(flags, 'title'),
      markdown: await body(flags, cwd),
      ...optional(flags, { folder: 'folder' })
    })
    printResult(result, json, formatDocsWrite)
  },
  'docs append': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<DocsWriteView>(client, 'google.docs.append', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref'),
      markdown: await body(flags, cwd)
    })
    printResult(result, json, formatDocsWrite)
  },
  'docs replace': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<DocsWriteView>(client, 'google.docs.replace', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref'),
      pairs: await pairs(flags, cwd),
      ...on(flags, 'suggest'),
      ...on(flags, 'all'),
      ...(flags.get('match-case') === true ? { matchCase: true } : {})
    })
    printResult(result, json, formatDocsWrite)
  },
  'docs comment': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<DocsWriteView>(client, 'google.docs.comment', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref'),
      text: await body(flags, cwd),
      ...optional(flags, { on: 'on' })
    })
    printResult(result, json, formatDocsWrite)
  },
  'sheets create': async ({ flags, client, json }) => {
    const result = await callGoogle<SheetsWriteView>(client, 'google.sheets.create', {
      ...googleCallParams(flags),
      title: getRequiredStringFlag(flags, 'title')
    })
    printResult(result, json, formatSheetsWrite)
  },
  'sheets read': async ({ flags, client, json }) => {
    const result = await callGoogle<SheetsReadView>(client, 'google.sheets.read', {
      ...googleCallParams(flags),
      ref: getRequiredStringFlag(flags, 'ref'),
      ...optional(flags, { tab: 'tab', range: 'range' })
    })
    printResult(result, json, formatSheetsRead)
  },
  'sheets write': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<SheetsWriteView>(client, 'google.sheets.write', {
      ...(await sheetValues(flags, cwd)),
      range: getRequiredStringFlag(flags, 'range')
    })
    printResult(result, json, formatSheetsWrite)
  },
  'sheets append': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<SheetsWriteView>(
      client,
      'google.sheets.append',
      await sheetValues(flags, cwd)
    )
    printResult(result, json, formatSheetsWrite)
  },
  'sheets upsert': async ({ flags, client, json, cwd }) => {
    const result = await callGoogle<SheetsWriteView>(client, 'google.sheets.upsert', {
      ...(await sheetValues(flags, cwd)),
      key: getRequiredStringFlag(flags, 'key')
    })
    printResult(result, json, formatSheetsWrite)
  }
}
