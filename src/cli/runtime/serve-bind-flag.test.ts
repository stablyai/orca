import { describe, expect, it } from 'vitest'
import { getOptionalServeBind, resolveServeBindValue } from './serve-bind-flag'

describe('serve bind flag', () => {
  it('leaves an omitted flag undefined and normalizes localhost', () => {
    expect(getOptionalServeBind(new Map())).toBeUndefined()
    expect(getOptionalServeBind(new Map([['bind', 'localhost']]))).toBe('127.0.0.1')
  })

  it('rejects explicit empty values and hostnames', () => {
    expect(() => getOptionalServeBind(new Map([['bind', '']]))).toThrow('Missing value for --bind')
    expect(() => resolveServeBindValue('server.example')).toThrow(
      /--bind expects a literal IP address/
    )
  })
})
