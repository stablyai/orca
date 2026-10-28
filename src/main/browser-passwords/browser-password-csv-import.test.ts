import { describe, expect, it } from 'vitest'
import {
  BROWSER_PASSWORD_CSV_MAX_BYTES,
  BROWSER_PASSWORD_CSV_MAX_ROWS,
  parseBrowserPasswordCsv
} from './browser-password-csv-import'

const login = { url: 'https://example.com/login', username: 'alice', password: 'p@ss' }

describe('parseBrowserPasswordCsv headers', () => {
  it('reads a Chrome export', () => {
    const result = parseBrowserPasswordCsv(
      'name,url,username,password,note\r\nexample.com,https://example.com/login,alice,p@ss,hi\r\n'
    )
    expect(result).toEqual({ rows: [{ ...login, note: 'hi', name: 'example.com' }], invalid: 0 })
  })

  it('reads a Firefox export', () => {
    const result = parseBrowserPasswordCsv(
      '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n' +
        '"https://example.com/login","alice","p@ss",,"https://example.com","{abc}","1","2","3"\n'
    )
    expect(result.rows).toEqual([{ ...login, note: '', name: '' }])
  })

  it('reads a Safari export', () => {
    const result = parseBrowserPasswordCsv(
      'Title,URL,Username,Password,Notes,OTPAuth\nExample,https://example.com/login,alice,p@ss,n,\n'
    )
    expect(result.rows).toEqual([{ ...login, note: 'n', name: 'Example' }])
  })

  it('reads a Bitwarden export', () => {
    const result = parseBrowserPasswordCsv(
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
        ',,login,Example,n,,0,https://example.com/login,alice,p@ss,\n'
    )
    expect(result.rows).toEqual([{ ...login, note: 'n', name: 'Example' }])
  })

  it('reads a LastPass export', () => {
    const result = parseBrowserPasswordCsv(
      'url,username,password,totp,extra,name,grouping,fav\nhttps://example.com/login,alice,p@ss,,n,Example,,0\n'
    )
    expect(result.rows).toEqual([{ ...login, note: 'n', name: 'Example' }])
  })

  it('prefers username over an earlier email column', () => {
    const result = parseBrowserPasswordCsv(
      'type,name,url,email,username,password,note\nlogin,Ex,https://example.com/login,a@x.com,alice,p@ss,\n'
    )
    expect(result.rows[0]?.username).toBe('alice')
  })

  it('matches headers case-insensitively after trimming', () => {
    const result = parseBrowserPasswordCsv(
      ' URL , Login , Password \nhttps://example.com/login,alice,p@ss\n'
    )
    expect(result.rows).toEqual([{ ...login, note: '', name: '' }])
  })

  it('reports missing required columns', () => {
    expect(parseBrowserPasswordCsv('name,url,password\nx,https://a.com,p\n')).toEqual({
      rows: [],
      invalid: 0,
      error: 'missing-columns'
    })
    expect(parseBrowserPasswordCsv('').error).toBe('missing-columns')
  })
})

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

  it('skips blank lines and fills short rows with empty fields', () => {
    const result = parseBrowserPasswordCsv('url,username,password\n\nhttps://a.com,bob\n')
    expect(result.rows).toEqual([
      { url: 'https://a.com', username: 'bob', password: '', note: '', name: '' }
    ])
  })
})

describe('parseBrowserPasswordCsv limits', () => {
  it('refuses text over 1 MB', () => {
    const text = `url,username,password\n${'x'.repeat(BROWSER_PASSWORD_CSV_MAX_BYTES)}`
    expect(parseBrowserPasswordCsv(text).error).toBe('too-large')
  })

  it('refuses more than 3000 rows', () => {
    const body = 'https://a.com,u,p\n'.repeat(BROWSER_PASSWORD_CSV_MAX_ROWS + 1)
    expect(parseBrowserPasswordCsv(`url,username,password\n${body}`).error).toBe('too-many-rows')
    const atLimit = 'https://a.com,u,p\n'.repeat(BROWSER_PASSWORD_CSV_MAX_ROWS)
    expect(parseBrowserPasswordCsv(`url,username,password\n${atLimit}`).rows).toHaveLength(
      BROWSER_PASSWORD_CSV_MAX_ROWS
    )
  })

  it('counts rows over a field limit as invalid', () => {
    const longUrl = `https://a.com/${'x'.repeat(2048)}`
    const longPassword = 'p'.repeat(1001)
    const result = parseBrowserPasswordCsv(
      `url,username,password\n${longUrl},u,p\nhttps://a.com,u,${longPassword}\nhttps://a.com,u,p\n`
    )
    expect(result.invalid).toBe(2)
    expect(result.rows).toHaveLength(1)
  })
})
