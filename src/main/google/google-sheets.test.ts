import { afterEach, describe, expect, it } from 'vitest'
import { googleJson } from './google-api.test-fixture'
import { filesApi, route } from './google-files.test-fixture'
import { appendSheet, cellsForInput, readSheet, upsertSheet, writeSheet } from './google-sheets'

let cleanup = (): void => {}
afterEach(() => cleanup())

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const VALUES = `/v4/spreadsheets/${ID}/values/`

async function sheetsApi(routes: Parameters<typeof filesApi>[0] = []) {
  const google = await filesApi([
    route('GET', `/v4/spreadsheets/${ID}`, () =>
      googleJson(200, {
        spreadsheetId: ID,
        properties: { title: 'Leads' },
        sheets: [
          { properties: { title: 'Q4', gridProperties: { rowCount: 1000, columnCount: 26 } } },
          { properties: { title: 'Archive' } }
        ]
      })
    ),
    ...routes
  ])
  cleanup = google.cleanup
  return google
}

describe('sheets read', () => {
  it('shows the first tab with no tab or range, and names every tab', async () => {
    const { api, sent } = await sheetsApi([
      route('GET', `${VALUES}'Q4'`, () =>
        googleJson(200, { range: "'Q4'!A1:Z1000", values: [['Name', 'Email'], ['Ada']] })
      )
    ])
    const view = await readSheet(api, { ref: ID })
    expect(view.tabs.map((tab) => tab.title)).toEqual(['Q4', 'Archive'])
    expect(view.values).toEqual([['Name', 'Email'], ['Ada']])
    expect(view.origin).toEqual({ row: 1, column: 1 })
    expect(view.nextRange).toBeUndefined()
    expect(sent[1]?.url.pathname).toBe(`${VALUES}'Q4'`)
  })

  it('holds back whole rows past the answer’s size and names the next range', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => [`row ${i}`, 'x'.repeat(100)])
    const { api } = await sheetsApi([
      route('GET', `${VALUES}'Archive'!B5%3AC`, () =>
        googleJson(200, { range: "'Archive'!B5:C404", values: rows })
      )
    ])
    const view = await readSheet(api, { ref: ID, tab: 'archive', range: 'B5:C' })
    expect(view.values.length).toBeLessThan(400)
    expect(view.origin).toEqual({ row: 5, column: 2 })
    expect(view.nextRange).toBe(`B${5 + view.values.length}:C404`)
  })

  it('refuses a tab that isn’t there, naming the ones that are', async () => {
    const { api } = await sheetsApi()
    await expect(readSheet(api, { ref: ID, tab: 'Q5' })).rejects.toThrow('Its tabs: Q4, Archive.')
  })
})

describe('sheets writes', () => {
  it('keeps text that would start a formula as text unless formulas are asked for', () => {
    expect(cellsForInput([['=SUM(A1:A2)', '-5', '+1 555', '@ada', 42, null]], false)).toEqual([
      ["'=SUM(A1:A2)", '-5', "'+1 555", "'@ada", 42, null]
    ])
    expect(cellsForInput([['=SUM(A1:A2)']], true)).toEqual([['=SUM(A1:A2)']])
  })

  it('writes typed-in values to the tab and range named', async () => {
    const { api, writes } = await sheetsApi([
      route('PUT', `${VALUES}'Q4'!B2`, () => googleJson(200, { updatedRange: "'Q4'!B2" }))
    ])
    const view = await writeSheet(api, { ref: ID, tab: 'Q4', range: 'B2', values: [[1200]] })
    expect(view).toMatchObject({ done: 'Wrote 1 row', ranges: ["'Q4'!B2"] })
    expect(writes()[0]?.url.searchParams.get('valueInputOption')).toBe('USER_ENTERED')
    expect(writes()[0]?.body).toEqual({
      range: "'Q4'!B2",
      majorDimension: 'ROWS',
      values: [[1200]]
    })
  })

  it('appends rows as new rows', async () => {
    const { api, writes } = await sheetsApi([
      route('POST', `${VALUES}'Q4'!A1:append`, () =>
        googleJson(200, { updates: { updatedRange: "'Q4'!A3:B3" } })
      )
    ])
    const view = await appendSheet(api, { ref: ID, values: [['Sam', 'sam@x.com']] })
    expect(view.ranges).toEqual(["'Q4'!A3:B3"])
    expect(writes()[0]?.url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS')
  })

  it('upserts by a header name: updates the matching row, adds the rest', async () => {
    const { api, writes } = await sheetsApi([
      route('GET', `${VALUES}'Q4'`, () =>
        googleJson(200, {
          range: "'Q4'!A1:C3",
          values: [
            ['Name', 'Email', 'Score'],
            ['Ada', 'ada@acme.dev', '1'],
            ['Sam', 'sam@x.com', '2']
          ]
        })
      ),
      route('POST', `/v4/spreadsheets/${ID}/values:batchUpdate`, () => googleJson(200, {})),
      route('POST', `${VALUES}'Q4'!A1:append`, () =>
        googleJson(200, { updates: { updatedRange: "'Q4'!A4:C4" } })
      )
    ])
    const view = await upsertSheet(api, {
      ref: ID,
      key: 'email',
      values: [
        ['Name', 'Email', 'Score'],
        ['Sam', 'sam@x.com', 9],
        ['Lee', 'lee@x.com', 3]
      ]
    })
    expect(view.done).toBe('Updated 1, added 1')
    expect(writes()[0]?.body).toEqual({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: "'Q4'!A3", values: [['Sam', 'sam@x.com', 9]] }]
    })
    expect(writes()[1]?.body).toEqual({ majorDimension: 'ROWS', values: [['Lee', 'lee@x.com', 3]] })
    await expect(upsertSheet(api, { ref: ID, key: 'Phone', values: [['x']] })).rejects.toThrow(
      'No column "Phone". Use a header from row 1 (Name, Email, Score) or a column letter.'
    )
  })
})
