import { describe, expect, it } from 'vitest'
import { parseBrowserPasswordCsv } from './browser-password-csv-import'

describe('parseBrowserPasswordCsv RFC 4180', () => {
  it('handles BOM, quotes, escaped quotes, embedded newlines and no trailing newline', () => {
    const result = parseBrowserPasswordCsv(
      '﻿url,username,password,note\n"https://example.com/login","al,ice","p""a\r\nss","line1\nline2"'
    )
    expect(result.rows).toEqual([
      {
        url: 'https://example.com/login',
        username: 'al,ice',
        password: 'p"a\r\nss',
        note: 'line1\nline2',
        name: ''
      }
    ])
  })

  it('drops spaces and tabs after a closing quote', () => {
    const result = parseBrowserPasswordCsv(
      '"url" ,username,"password"\t\n"https://a.test" ,bob,"pw" \r\nhttps://b.test,carol,"x"  '
    )
    expect(result.rows.map(({ url, username, password }) => [url, username, password])).toEqual([
      ['https://a.test', 'bob', 'pw'],
      ['https://b.test', 'carol', 'x']
    ])
  })

  it.each([
    [
      'never closed',
      'url,username,password\nhttps://first.test,alice,complete\nhttps://second.test,bob,"secret\nhttps://third.test,carol,other'
    ],
    ['truncated at end of file', 'url,username,password\nhttps://second.test,bob,"secr'],
    [
      'closed by a later quoted field',
      'url,username,password\nhttps://second.test,bob,"secret\nhttps://third.test,carol,"other"'
    ],
    [
      'closed by a later fully quoted row',
      '"url","username","password"\n"https://second.test","bob","secret\n"https://third.test","carol","other"\n'
    ],
    [
      'multi-line and followed by text',
      'url,username,password\nhttps://a.test,bob,"pw\nmore"x\nhttps://b.test,carol,ok'
    ]
  ])('rejects the whole file when a quoted field is %s', (_case, csv) => {
    expect(parseBrowserPasswordCsv(csv)).toEqual({ rows: [], invalid: 0, error: 'malformed-csv' })
  })

  it('counts a one-line field with text after its closing quote as unreadable', () => {
    const result = parseBrowserPasswordCsv(
      'url,username,password\nhttps://a.test,alice,"pw"x\nhttps://b.test,bob,"pw" x,"note\nline"\r\nhttps://c.test,carol,ok'
    )
    expect(result.rows.map(({ url, username, password }) => [url, username, password])).toEqual([
      ['https://c.test', 'carol', 'ok']
    ])
    expect(result.invalid).toBe(2)
    expect(result.error).toBeUndefined()
  })
})
