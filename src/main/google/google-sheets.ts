// `orca sheets create|read|write|append|upsert`: cells by tab and A1 range. Values go in the way a
// person typing them would (numbers and dates understood), but text that would start a formula is
// kept as text unless formulas were asked for.
import { z } from 'zod'
import type {
  SheetsReadView,
  SheetsTab,
  SheetsWriteView
} from '../../shared/google/google-files-types'
import { columnLetters, columnNumber, quotedTab, splitA1 } from '../../shared/google/sheets-a1'
import { TOOL_OUTPUT_MAX_CHARS } from '../../shared/tool-output-limits'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import { requireDriveId } from './google-drive-files'

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
// Room under the output cap for Orca's own lines around the table.
const READ_BUDGET_CHARS = TOOL_OUTPUT_MAX_CHARS - 2_000

export type Cell = string | number | boolean | null

const SpreadsheetSchema = z.object({
  spreadsheetId: z.string(),
  spreadsheetUrl: z.string().optional(),
  properties: z.object({ title: z.string() }),
  sheets: z
    .array(
      z.object({
        properties: z.object({
          title: z.string(),
          gridProperties: z
            .object({ rowCount: z.number().optional(), columnCount: z.number().optional() })
            .optional()
        })
      })
    )
    .default([])
})
type Spreadsheet = z.infer<typeof SpreadsheetSchema>
const ValuesSchema = z.object({
  range: z.string(),
  values: z.array(z.array(z.unknown())).default([])
})

const linkOf = (sheet: Spreadsheet) =>
  sheet.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`

export async function getSpreadsheet(api: GoogleApi, ref: string): Promise<Spreadsheet> {
  const id = requireDriveId(ref, 'spreadsheet')
  const url = new URL(`${SHEETS}/${encodeURIComponent(id)}`)
  url.searchParams.set(
    'fields',
    'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))'
  )
  const sheet = await api.find('sheets', url.toString(), parseGoogleJson(SpreadsheetSchema))
  if (!sheet) {
    throw new GoogleToolError(`No spreadsheet ${id} that ${api.email} can see.`)
  }
  return sheet
}

const tabsOf = (sheet: Spreadsheet): SheetsTab[] =>
  sheet.sheets.map(({ properties }) => ({
    title: properties.title,
    rows: properties.gridProperties?.rowCount ?? 0,
    columns: properties.gridProperties?.columnCount ?? 0
  }))

/** The tab asked for, matched as written or ignoring case; the first tab when none is named. */
function pickTab(sheet: Spreadsheet, wanted: string | undefined): string {
  const titles = sheet.sheets.map((entry) => entry.properties.title)
  if (!wanted) {
    const first = titles[0]
    if (first === undefined) {
      throw new GoogleToolError('This spreadsheet has no tabs.')
    }
    return first
  }
  const found =
    titles.find((title) => title === wanted) ??
    titles.find((title) => title.toLowerCase() === wanted.toLowerCase())
  if (found === undefined) {
    throw new GoogleToolError(`No tab "${wanted}". Its tabs: ${titles.join(', ')}.`)
  }
  return found
}

const valuesUrl = (id: string, range: string, suffix = '') =>
  new URL(`${SHEETS}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}${suffix}`)

const asText = (value: unknown) =>
  value === null || value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)

export async function createSheet(api: GoogleApi, title: string): Promise<SheetsWriteView> {
  const sheet = await api.send(
    'sheets',
    { method: 'POST', url: SHEETS, json: { properties: { title } } },
    parseGoogleJson(SpreadsheetSchema)
  )
  return {
    account: api.email,
    id: sheet.spreadsheetId,
    title: sheet.properties.title,
    link: linkOf(sheet),
    done: 'Created',
    ranges: []
  }
}

export async function readSheet(
  api: GoogleApi,
  args: { ref: string; tab?: string; range?: string }
): Promise<SheetsReadView> {
  const sheet = await getSpreadsheet(api, args.ref)
  const tab = pickTab(sheet, args.tab)
  const answer = await api.get(
    'sheets',
    valuesUrl(
      sheet.spreadsheetId,
      args.range ? `${quotedTab(tab)}!${args.range}` : quotedTab(tab)
    ).toString(),
    parseGoogleJson(ValuesSchema)
  )
  const where = splitA1(answer.range)
  const rows = answer.values.map((row) => row.map(asText))
  // Whole rows only, until the answer's budget; the rest is named as the next range.
  let used = 0
  let kept = 0
  for (const row of rows) {
    used += row.reduce((sum, cell) => sum + cell.length + 3, 8)
    if (used > READ_BUDGET_CHARS && kept > 0) {
      break
    }
    kept++
  }
  const end = /:([A-Za-z]*)(\d*)$/.exec(where.cells)
  const nextRow = where.row + kept
  return {
    account: api.email,
    id: sheet.spreadsheetId,
    title: sheet.properties.title,
    link: linkOf(sheet),
    tabs: tabsOf(sheet),
    range: answer.range,
    values: rows.slice(0, kept),
    origin: { row: where.row, column: where.column },
    ...(kept < rows.length
      ? {
          nextRange: `${columnLetters(where.column)}${nextRow}:${end?.[1] || columnLetters(where.column + rows.reduce((max, row) => Math.max(max, row.length), 0) - 1)}${end?.[2] ?? ''}`
        }
      : {})
  }
}

/** Every tab as a table, for `orca drive read` of a spreadsheet. */
export async function readAllTabs(
  api: GoogleApi,
  ref: string
): Promise<{ title: string; tabs: { title: string; values: string[][]; range: string }[] }> {
  const sheet = await getSpreadsheet(api, ref)
  const url = new URL(`${SHEETS}/${encodeURIComponent(sheet.spreadsheetId)}/values:batchGet`)
  for (const entry of sheet.sheets) {
    url.searchParams.append('ranges', quotedTab(entry.properties.title))
  }
  const answer = await api.get(
    'sheets',
    url.toString(),
    parseGoogleJson(z.object({ valueRanges: z.array(ValuesSchema).default([]) }))
  )
  return {
    title: sheet.properties.title,
    tabs: answer.valueRanges.map((range, index) => ({
      title: sheet.sheets[index]?.properties.title ?? splitA1(range.range).tab ?? '',
      range: range.range,
      values: range.values.map((row) => row.map(asText))
    }))
  }
}

/** Text that would start a formula stays text (a leading apostrophe), unless formulas are wanted. */
export function cellsForInput(values: Cell[][], formulas: boolean): Cell[][] {
  return values.map((row) =>
    row.map((cell) =>
      !formulas &&
      typeof cell === 'string' &&
      /^[=+\-@]/.test(cell) &&
      !/^[+-]?\d+(\.\d+)?$/.test(cell)
        ? `'${cell}`
        : cell
    )
  )
}

type ValuesWrite = { ref: string; tab?: string; values: Cell[][]; formulas?: boolean }

const UpdateSchema = z.object({ updatedRange: z.string().optional() })

export async function writeSheet(
  api: GoogleApi,
  args: ValuesWrite & { range: string }
): Promise<SheetsWriteView> {
  const sheet = await getSpreadsheet(api, args.ref)
  const range = `${quotedTab(pickTab(sheet, args.tab))}!${args.range}`
  const url = valuesUrl(sheet.spreadsheetId, range)
  url.searchParams.set('valueInputOption', 'USER_ENTERED')
  const values = cellsForInput(args.values, args.formulas === true)
  const answer = await api.send(
    'sheets',
    { method: 'PUT', url: url.toString(), json: { range, majorDimension: 'ROWS', values } },
    parseGoogleJson(UpdateSchema)
  )
  return written(api, sheet, `Wrote ${values.length} row${values.length === 1 ? '' : 's'}`, [
    answer.updatedRange ?? range
  ])
}

async function appendRows(api: GoogleApi, sheet: Spreadsheet, tab: string, values: Cell[][]) {
  const url = valuesUrl(sheet.spreadsheetId, `${quotedTab(tab)}!A1`, ':append')
  url.searchParams.set('valueInputOption', 'USER_ENTERED')
  url.searchParams.set('insertDataOption', 'INSERT_ROWS')
  const answer = await api.send(
    'sheets',
    { method: 'POST', url: url.toString(), json: { majorDimension: 'ROWS', values } },
    parseGoogleJson(z.object({ updates: UpdateSchema.optional() }))
  )
  return answer.updates?.updatedRange ?? quotedTab(tab)
}

export async function appendSheet(api: GoogleApi, args: ValuesWrite): Promise<SheetsWriteView> {
  const sheet = await getSpreadsheet(api, args.ref)
  const values = cellsForInput(args.values, args.formulas === true)
  const range = await appendRows(api, sheet, pickTab(sheet, args.tab), values)
  return written(api, sheet, `Added ${values.length} row${values.length === 1 ? '' : 's'}`, [range])
}

/** Updates the row whose key column matches, else adds it. Not atomic: a concurrent edit can race. */
export async function upsertSheet(
  api: GoogleApi,
  args: ValuesWrite & { key: string }
): Promise<SheetsWriteView> {
  const sheet = await getSpreadsheet(api, args.ref)
  const tab = pickTab(sheet, args.tab)
  const current = await api.get(
    'sheets',
    valuesUrl(sheet.spreadsheetId, quotedTab(tab)).toString(),
    parseGoogleJson(ValuesSchema)
  )
  const origin = splitA1(current.range)
  const existing = current.values.map((row) => row.map((cell) => asText(cell).trim()))
  const header = existing[0] ?? []
  const keyIndex = keyColumn(header, args.key, origin.column)
  // Keys match the stored text; the formula escape applies only to what gets written.
  const formulas = args.formulas === true
  // A header row passed along with the data is not a row to add.
  const rows = args.values.filter((row, index) => !(index === 0 && sameRow(row, header)))
  const updates: { range: string; values: Cell[][] }[] = []
  const additions: Cell[][] = []
  for (const row of rows) {
    const key = asText(row[keyIndex]).trim()
    if (!key) {
      throw new GoogleToolError(`A row has no value in the key column ${args.key}.`)
    }
    const at = existing.findIndex((line, index) => index > 0 && line[keyIndex] === key)
    if (at === -1) {
      additions.push(row)
      continue
    }
    updates.push({
      range: `${quotedTab(tab)}!${columnLetters(origin.column)}${origin.row + at}`,
      values: cellsForInput([row], formulas)
    })
  }
  const ranges: string[] = []
  if (updates.length > 0) {
    await api.send(
      'sheets',
      {
        method: 'POST',
        url: `${SHEETS}/${encodeURIComponent(sheet.spreadsheetId)}/values:batchUpdate`,
        json: { valueInputOption: 'USER_ENTERED', data: updates }
      },
      parseGoogleJson(z.object({}).passthrough())
    )
    ranges.push(...updates.map((update) => update.range))
  }
  if (additions.length > 0) {
    ranges.push(await appendRows(api, sheet, tab, cellsForInput(additions, formulas)))
  }
  return written(api, sheet, `Updated ${updates.length}, added ${additions.length}`, ranges)
}

/** The key column by its header (ignoring case), or by letter when no header has that name. */
function keyColumn(header: string[], key: string, firstColumn: number): number {
  const byName = header.findIndex((name) => name.toLowerCase() === key.trim().toLowerCase())
  if (byName !== -1) {
    return byName
  }
  if (/^[A-Za-z]{1,3}$/.test(key.trim())) {
    const index = columnNumber(key.trim()) - firstColumn
    if (index >= 0) {
      return index
    }
  }
  throw new GoogleToolError(
    `No column "${key}". Use a header from row 1 (${header.filter(Boolean).join(', ') || 'none'}) or a column letter.`
  )
}

const sameRow = (row: Cell[], header: string[]) =>
  header.length > 0 &&
  row.length === header.length &&
  row.every((cell, i) => asText(cell).trim() === header[i])

function written(
  api: GoogleApi,
  sheet: Spreadsheet,
  done: string,
  ranges: string[]
): SheetsWriteView {
  return {
    account: api.email,
    id: sheet.spreadsheetId,
    title: sheet.properties.title,
    link: linkOf(sheet),
    done,
    ranges
  }
}
