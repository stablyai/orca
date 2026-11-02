import { describe, expect, it } from 'vitest'
import {
  decodeAntigravityWindowsToken,
  parseAntigravityWindowsSnapshot,
  projectAntigravityWindowsToken
} from './native-windows-token-decode'

const decode = (raw: string) => decodeAntigravityWindowsToken(Buffer.from(raw))
const jwt = (payload: string) => `.${Buffer.from(payload).toString('base64url')}.`

describe('ordered Windows token decoding', () => {
  it.each([
    '{}',
    'null',
    '{"unknown":1}',
    '{"auth_method":"consumer"}',
    '{"token":{}}',
    '{"token":7}',
    '{"token":{"access_token":"a"},"token":null}',
    '{"id_token_email":"x","access_token":7}',
    '{"project_id":"p","PROJECT_ID":null,"access_token":7}'
  ])('retains native authority without inventing a usable OAuth snapshot: %s', (raw) => {
    expect(decode(raw)).not.toBeNull()
    expect(() => parseAntigravityWindowsSnapshot(raw)).toThrow()
  })

  it.each([
    '{"access_token":7}',
    '{"access_token":7,"access_token":"a"}',
    '{"token":{"access_token":"a"},"project_id":17,"expires_in":"x"}',
    '{"id_token_email":"x","id_token":7,"access_token":7}',
    '{"project_id":"p","PROJECT_ID":"","access_token":7}',
    '{"project-id":"p","access_token":7}',
    '\ufeff{"access_token":"a"}',
    '{}{}',
    '{"token":{},}',
    '{/*x*/"token":{}}',
    '[{}]',
    '7',
    'true',
    '{"token":"\\x"}',
    '{"unknown":01}',
    ''
  ])('rejects both typed attempts before consulting fallback: %s', (raw) => {
    expect(decode(raw)).toBeNull()
  })

  it.each([
    ['{"ACCESS_TOKEN":"a","access_token":null}', 'a', null],
    ['{"toKen":{"acceſſ_token":"a"},"TOKEN":{"access_token":null,"refresh_token":"r"}}', 'a', 'r'],
    ['{"token":{"access_token":"a"},"token":{"access_token":"b"}}', 'b', null],
    ['{"auth_method":"consumer","access_token":"a"}', 'a', null],
    ['{"token":{"access_token":"wrong","expiry":7},"access_token":"a"}', 'a', null],
    ['{"token":{"access_token":"a"},"expiry":7,"expires_in":"bad"}', 'a', null]
  ])(
    'projects typed values while preserving original contents: %s',
    (raw, accessToken, refreshToken) => {
      expect(parseAntigravityWindowsSnapshot(raw)).toMatchObject({
        contents: raw,
        accessToken,
        refreshToken
      })
    }
  )

  it.each([
    ['{"email":"e"}', 'e'],
    ['{"EMAIL":"e"}', 'e'],
    ['{"email":"a","EMAIL":"b"}', 'b'],
    ['{"email":"e","email":null}', 'e'],
    ['{"email":"e","email":""}', ''],
    ['null', ''],
    ['{"email":7,"email":"e"}', ''],
    ['{"email":"e","name":7}', '']
  ])('applies the actual root ID-token email method: %s', (payload, email) => {
    const raw = JSON.stringify({ id_token: jwt(payload), access_token: 7 })
    const value = decode(raw)
    expect(value?.strings.get('id_token_email') ?? '').toBe(email)
    expect(value !== null).toBe(Boolean(email))
  })

  it('retains outer ID-token null history through the custom method, but honors an empty overwrite', () => {
    const prefix = `{"access_token":7,"id_token":${JSON.stringify(jwt('{"email":"e"}'))}`
    expect(decode(`${prefix},"ID_TOKEN":null}`)?.strings.get('id_token_email')).toBe('e')
    expect(decode(`${prefix},"ID_TOKEN":""}`)).toBeNull()
    expect(
      parseAntigravityWindowsSnapshot('{"auth_method":"consumer","access_token":"a"}').authMethod
    ).toBe('')
  })

  it('uses raw URL base64 with CR/LF, no padding, no header/signature validation', () => {
    const good = jwt('{"email":"e"}')
    const payload = good.split('.')[1]
    for (const id_token of [
      good,
      `.\r\n${payload}.`,
      `x.${payload}.x`,
      `.${payload.slice(0, -1)}R.`
    ]) {
      expect(decode(JSON.stringify({ id_token, access_token: 7 }))).not.toBeNull()
    }
    for (const id_token of [`.${payload}==.`, 'x.e.x', `${good}.extra`, 'x.+/.x']) {
      expect(decode(JSON.stringify({ id_token, access_token: 7 }))).toBeNull()
    }
  })

  it.each(['0', 'null', '-0', '9223372036854775807', '-9223372036854775808'])(
    'accepts actual int64 values %s',
    (value) => {
      expect(
        parseAntigravityWindowsSnapshot(`{"access_token":"a","expires_in":${value}}`).accessToken
      ).toBe('a')
    }
  )
  it.each(['"1"', '1e0', '1.5', '9223372036854775808', '-9223372036854775809', 'true'])(
    'retains integer errors despite later duplicates %s',
    (value) => {
      expect(decode(`{"expires_in":${value},"EXPIRES_IN":7}`)).toBeNull()
      expect(
        decode(`{"token":{"access_token":"a","expires_in":${value}}}`)?.token?.strings.size
      ).toBe(0)
    }
  )

  it.each([
    '2026-10-28T12:34:56Z',
    '2026-10-28T1:34:56Z',
    '2026-10-28T12:34:56,25Z',
    '2026-10-28T12:34:56.1234567899Z',
    '2026-10-28T12:34:56+24:00',
    '2026-10-28T12:34:56+00:60',
    '2026-10-28T12:34:56+24:60',
    '0000-02-29T00:00:00Z'
  ])('accepts the effective lenient time grammar after JSON unquote: %s', (expiry) => {
    const raw = JSON.stringify({ access_token: 'a', expiry }).replace(/Z/g, '\\u005a')
    expect(parseAntigravityWindowsSnapshot(raw).accessToken).toBe('a')
    expect(decode(`${raw.slice(0, -1)},"expiry":null}`)).not.toBeNull()
  })
  it.each([
    '2026-10-28T12:34:56+25:00',
    '2026-10-28T12:34:56+00:61',
    '2026-10-28t12:34:56Z',
    '2026-10-28T12:34:56z',
    '2026-10-28T12:34:56Z\n',
    '2026-10-28T12:34:56.Z',
    '2026-10-28T12:34:60Z',
    '2026-02-29T12:34:56Z',
    '0'
  ])('retains time errors %s', (expiry) => {
    expect(decode(JSON.stringify({ access_token: 'a', expiry }))).toBeNull()
    expect(
      decode(`{"expiry":${JSON.stringify(expiry)},"expiry":"2026-10-28T12:34:56Z"}`)
    ).toBeNull()
  })

  it('separates replacement-decoded authority from a lossless string snapshot', () => {
    const bytes = Buffer.concat([
      Buffer.from('{"token":{"access_token":"'),
      Buffer.from([0xe2, 0x82]),
      Buffer.from('"}}')
    ])
    expect(decodeAntigravityWindowsToken(bytes)?.token?.strings.get('access_token')).toBe(
      '\ufffd\ufffd'
    )
    expect(() => projectAntigravityWindowsToken(bytes)).toThrow('losslessly')
    const rejected = Buffer.concat([
      Buffer.from('{"access_token":7,"unknown":"'),
      Buffer.from([255]),
      Buffer.from('"}')
    ])
    expect(decodeAntigravityWindowsToken(rejected)).toBeNull()
    expect(decodeAntigravityWindowsToken(Buffer.from([255]))).toBeNull()
    expect(parseAntigravityWindowsSnapshot('{"access_token":"\\ud800"}').accessToken).toBe('\ufffd')
    expect(() => parseAntigravityWindowsSnapshot('{"access_token":"\ud800"}')).toThrow('losslessly')
  })
})
