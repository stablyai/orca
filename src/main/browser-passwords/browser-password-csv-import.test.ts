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
})
