import { afterEach, describe, expect, it } from 'vitest'
import { googleJson } from './google-api.test-fixture'
import { filesApi, route } from './google-files.test-fixture'
import { appendSheet, readSheet, upsertSheet, writeSheet } from './google-sheets'

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
  it('defaults to the first tab and names the available tabs for an unknown one', async () => {
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
    await expect(readSheet(api, { ref: ID, tab: 'Q5' })).rejects.toThrow('Its tabs: Q4, Archive.')
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
})

describe('sheets writes', () => {
  it('writes typed values to the chosen range and escapes formulas unless requested', async () => {
    const { api, writes } = await sheetsApi([
      route('PUT', `${VALUES}'Q4'!B2`, () => googleJson(200, { updatedRange: "'Q4'!B2" }))
    ])
    const view = await writeSheet(api, {
      ref: ID,
      tab: 'Q4',
      range: 'B2',
      values: [['=SUM(A1:A2)', '-5', '+1 555', '@ada', 1200, null]]
    })
    expect(view).toMatchObject({ done: 'Wrote 1 row', ranges: ["'Q4'!B2"] })
    expect(writes()[0]?.url.searchParams.get('valueInputOption')).toBe('USER_ENTERED')
    expect(writes()[0]?.body).toEqual({
      range: "'Q4'!B2",
      majorDimension: 'ROWS',
      values: [["'=SUM(A1:A2)", '-5', "'+1 555", "'@ada", 1200, null]]
    })

    await writeSheet(api, {
      ref: ID,
      tab: 'Q4',
      range: 'B2',
      values: [['=SUM(A1:A2)']],
      formulas: true
    })
    expect(writes()[1]?.body).toMatchObject({ values: [['=SUM(A1:A2)']] })
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

  it('upserts keys and headers that look like formulas by their text, escaping only the writes', async () => {
    const { api, writes } = await sheetsApi([
      route('GET', `${VALUES}'Q4'`, () =>
        googleJson(200, {
          range: "'Q4'!A1:B5",
          values: [['@Handle', 'Score'], ['@ada'], ['=literal'], ['+phone'], ['-tag']]
        })
      ),
      route('POST', `/v4/spreadsheets/${ID}/values:batchUpdate`, () => googleJson(200, {})),
      route('POST', `${VALUES}'Q4'!A1:append`, () =>
        googleJson(200, { updates: { updatedRange: "'Q4'!A6:B6" } })
      )
    ])
    const view = await upsertSheet(api, {
      ref: ID,
      key: '@handle',
      values: [
        ['@Handle', 'Score'],
        ['@ada', 9],
        ['=literal', 8],
        ['+phone', 7],
        ['-tag', 6],
        ['@new', 5]
      ]
    })
    expect(view.done).toBe('Updated 4, added 1')
    expect(writes()[0]?.body).toEqual({
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: "'Q4'!A2", values: [["'@ada", 9]] },
        { range: "'Q4'!A3", values: [["'=literal", 8]] },
        { range: "'Q4'!A4", values: [["'+phone", 7]] },
        { range: "'Q4'!A5", values: [["'-tag", 6]] }
      ]
    })
    expect(writes()[1]?.body).toEqual({ majorDimension: 'ROWS', values: [["'@new", 5]] })
  })

  it('upserts with formulas: true by writing formulas unescaped on update and append', async () => {
    const { api, writes } = await sheetsApi([
      route('GET', `${VALUES}'Q4'`, () =>
        googleJson(200, {
          range: "'Q4'!A1:B2",
          values: [
            ['Name', 'Total'],
            ['Ada', '4']
          ]
        })
      ),
      route('POST', `/v4/spreadsheets/${ID}/values:batchUpdate`, () => googleJson(200, {})),
      route('POST', `${VALUES}'Q4'!A1:append`, () =>
        googleJson(200, { updates: { updatedRange: "'Q4'!A3:B3" } })
      )
    ])
    const view = await upsertSheet(api, {
      ref: ID,
      key: 'Name',
      formulas: true,
      values: [
        ['Ada', '=SUM(2,3)'],
        ['Grace', '=B2*2']
      ]
    })
    expect(view.done).toBe('Updated 1, added 1')
    expect(writes()[0]?.body).toEqual({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: "'Q4'!A2", values: [['Ada', '=SUM(2,3)']] }]
    })
    expect(writes()[1]?.body).toEqual({ majorDimension: 'ROWS', values: [['Grace', '=B2*2']] })
  })
})
