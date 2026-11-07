import { parseTree, type Node, type ParseError } from 'jsonc-parser'
import { projectAntigravityNativeCredential } from './native-credential-codec'

const storedStrings = [
  'auth_method',
  'id_token_email',
  'wif_provider',
  'saved_wif_provider',
  'project_id',
  'region',
  'user_tier',
  'tier_display_name',
  'id_token'
]
const tokenStrings = ['access_token', 'token_type', 'refresh_token']
type Token = { strings: Map<string, string>; idToken: string | null }
type StoredToken = { token: Token | null; strings: Map<string, string> }

// The host decoder replaces each invalid UTF-8 byte, rather than a truncated sequence.
function decodeBytes(bytes: Uint8Array): string {
  const result: string[] = []
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i]
    const width =
      first < 0x80
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0
    let point = first & (width === 1 ? 0x7f : (1 << (7 - width)) - 1)
    let valid = width > 0 && i + width <= bytes.length
    for (let j = 1; valid && j < width; j++) {
      valid = (bytes[i + j] & 0xc0) === 0x80
      point = (point << 6) | (bytes[i + j] & 0x3f)
    }
    valid &&=
      (width < 2 || point >= 0x80) &&
      (width < 3 || point >= 0x800) &&
      (width < 4 || point >= 0x10000) &&
      point <= 0x10ffff &&
      !(point >= 0xd800 && point <= 0xdfff)
    result.push(valid ? String.fromCodePoint(point) : '\ufffd')
    i += valid ? width : 1
  }
  return result.join('')
}

function stringValue(node: Node): string | null {
  return typeof node.value === 'string' ? node.value.toWellFormed() : null
}

// Only these two non-ASCII simple folds can match the ASCII field tags.
function fieldName(node: Node): string {
  return (stringValue(node) ?? '')
    .replace(/\u212a/g, 'k')
    .replace(/\u017f/g, 's')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

function tree(text: string): Node | undefined {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false })
  return errors.length === 0 ? root : undefined
}

function fields(node: Node, visit: (key: Node, value: Node) => void): boolean {
  if (node.type === 'null') {
    return true
  }
  if (node.type !== 'object') {
    return false
  }
  for (const property of node.children ?? []) {
    const [key, value] = property.children ?? []
    if (!key || !value) {
      return false
    }
    visit(key, value)
  }
  return true
}

function assignString(strings: Map<string, string>, name: string, value: Node): boolean {
  if (value.type === 'null') {
    return true
  }
  const text = stringValue(value)
  if (text === null) {
    return false
  }
  strings.set(name, text)
  return true
}

function validExpiry(node: Node): boolean {
  if (node.type === 'null') {
    return true
  }
  const text = stringValue(node)
  const match = text?.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2}):(\d{2})(?:[.,]\d+)?(Z|[+-](\d{2}):(\d{2}))$/
  )
  if (!match || match[0] !== text) {
    return false
  }
  const [, year, month, day, hour, minute, second, , zoneHour = '0', zoneMinute = '0'] = match
  const y = Number(year),
    m = Number(month),
    d = Number(day)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return (
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= days[m - 1] &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    Number(zoneHour) <= 24 &&
    Number(zoneMinute) <= 60
  )
}

function validInt64(node: Node, text: string): boolean {
  if (node.type === 'null') {
    return true
  }
  const raw = text.slice(node.offset, node.offset + node.length)
  if (node.type !== 'number' || !/^-?\d+$/.test(raw)) {
    return false
  }
  if (raw.replace(/^-/, '').length > 19) {
    return false
  }
  const value = BigInt(raw)
  return value >= -(1n << 63n) && value < 1n << 63n
}

function decodeToken(node: Node, token: Token, text: string): boolean {
  let valid = true
  const object = fields(node, (key, value) => {
    const name = fieldName(key)
    if (tokenStrings.includes(name)) {
      valid = assignString(token.strings, name, value) && valid
    } else if (name === 'expiry') {
      valid = validExpiry(value) && valid
    } else if (name === 'expires_in') {
      valid = validInt64(value, text) && valid
    }
    // Unverified local identity labels remain separate from the agent's token fields.
    else if (stringValue(key) === 'id_token') {
      token.idToken = stringValue(value)
    }
  })
  return object && valid
}

function token(): Token {
  return { strings: new Map(), idToken: null }
}

function claimsEmail(idToken: string): string {
  const parts = idToken.split('.')
  if (parts.length !== 3) {
    return ''
  }
  const payload = parts[1].replace(/[\r\n]/g, '')
  if (!/^[A-Za-z0-9_-]*$/.test(payload) || payload.length % 4 === 1) {
    return ''
  }
  const claims = tree(decodeBytes(Buffer.from(payload, 'base64url')))
  if (!claims) {
    return ''
  }
  const strings = new Map<string, string>()
  let valid = true
  const object = fields(claims, (key, value) => {
    const name = fieldName(key)
    if (['sub', 'email', 'name'].includes(name)) {
      valid = assignString(strings, name, value) && valid
    }
  })
  return object && valid ? (strings.get('email') ?? '') : ''
}

export function decodeAntigravityWindowsToken(bytes: Uint8Array): StoredToken | null {
  const text = decodeBytes(bytes)
  const root = tree(text)
  if (!root) {
    return null
  }
  const modern: StoredToken = { token: null, strings: new Map() }
  let valid = true
  const object = fields(root, (key, value) => {
    const name = fieldName(key)
    if (storedStrings.includes(name)) {
      valid = assignString(modern.strings, name, value) && valid
    } else if (name === 'token') {
      if (value.type === 'null') {
        modern.token = null
      } else {
        modern.token ??= token()
        valid = decodeToken(value, modern.token, text) && valid
      }
    }
  })
  if (object && valid) {
    if (!modern.strings.get('id_token_email') && modern.strings.get('id_token')) {
      modern.strings.set('id_token_email', claimsEmail(modern.strings.get('id_token') ?? ''))
    }
    if (modern.token || storedStrings.slice(1, -1).some((name) => modern.strings.get(name))) {
      return modern
    }
  }
  const legacy = token()
  return decodeToken(root, legacy, text) ? { token: legacy, strings: new Map() } : null
}

export function parseAntigravityWindowsSnapshot(contents: string) {
  const snapshot = projectAntigravityWindowsToken(Buffer.from(contents, 'utf8'))
  if (snapshot.contents !== contents) {
    throw new Error('The Antigravity Windows credential store cannot be saved losslessly.')
  }
  return snapshot
}

export function projectAntigravityWindowsToken(
  bytes: Uint8Array,
  decoded = decodeAntigravityWindowsToken(bytes)
) {
  if (!decoded) {
    throw new Error('The Antigravity Windows credential store could not be decoded.')
  }
  let contents: string
  try {
    contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('The Antigravity Windows credential store cannot be saved losslessly.')
  }
  return projectAntigravityNativeCredential(contents, {
    authMethod: decoded.strings.get('auth_method') ?? '',
    accessToken: decoded.token?.strings.get('access_token') ?? '',
    refreshToken: decoded.token?.strings.get('refresh_token') ?? null,
    idToken: decoded.strings.get('id_token') ?? decoded.token?.idToken
  })
}
