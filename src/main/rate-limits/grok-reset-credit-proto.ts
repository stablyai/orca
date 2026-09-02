import type { RateLimitResetCredits } from './codex-reset-credit-client'

export type GrokRemainingResetToken = {
  tokenId: string
  grantedAt: number | null
  expiresAt: number | null
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
function concatBytes(parts: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
function encodeVarint(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Varint must be a non-negative finite number')
  }
  let n = Math.floor(value)
  const bytes: number[] = []
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  bytes.push(n)
  return Uint8Array.from(bytes)
}

function encodeKey(field: number, wireType: number): Uint8Array<ArrayBuffer> {
  return encodeVarint((field << 3) | wireType)
}

function encodeLengthDelimited(
  field: number,
  data: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
  return concatBytes([encodeKey(field, 2), encodeVarint(data.byteLength), data])
}

export function encodeStringField(field: number, value: string): Uint8Array<ArrayBuffer> {
  return encodeLengthDelimited(field, textEncoder.encode(value))
}

// Why: grok.com's public consumer_ui descriptor defines ConsumerRedeemResetReq.token_id as field 10.
export function encodeRedeemResetRequest(tokenId: string): Uint8Array<ArrayBuffer> {
  return encodeStringField(10, tokenId)
}

function encodeTimestampSeconds(seconds: number): Uint8Array<ArrayBuffer> {
  return concatBytes([encodeKey(1, 0), encodeVarint(seconds)])
}

export function encodeGetRemainingResetsResponse(
  tokens: GrokRemainingResetToken[]
): Uint8Array<ArrayBuffer> {
  return concatBytes(
    tokens.map((token) => {
      const fields: Uint8Array<ArrayBufferLike>[] = [encodeStringField(10, token.tokenId)]
      if (token.grantedAt != null) {
        fields.push(
          encodeLengthDelimited(20, encodeTimestampSeconds(Math.floor(token.grantedAt / 1000)))
        )
      }
      if (token.expiresAt != null) {
        fields.push(
          encodeLengthDelimited(30, encodeTimestampSeconds(Math.floor(token.expiresAt / 1000)))
        )
      }
      return encodeLengthDelimited(10, concatBytes(fields))
    })
  )
}

function encodeGrpcWebFrame(
  flags: number,
  payload: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(5)
  header[0] = flags
  header[1] = (payload.byteLength >>> 24) & 0xff
  header[2] = (payload.byteLength >>> 16) & 0xff
  header[3] = (payload.byteLength >>> 8) & 0xff
  header[4] = payload.byteLength & 0xff
  return concatBytes([header, payload])
}

// Why: grok.com accepts a data frame only on the request; trailers are a response convention.
export function encodeGrpcWebRequest(
  payload: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
  return encodeGrpcWebFrame(0, payload)
}

export function encodeGrpcWebMessage(
  payload: Uint8Array<ArrayBufferLike>,
  trailerStatus = '0'
): Uint8Array<ArrayBuffer> {
  const trailer = textEncoder.encode(`grpc-status:${trailerStatus}\r\n`)
  return concatBytes([encodeGrpcWebFrame(0, payload), encodeGrpcWebFrame(0x80, trailer)])
}

function decodeVarint(
  buf: Uint8Array<ArrayBufferLike>,
  start: number
): { value: number; next: number } {
  let value = 0
  let shift = 0
  let i = start
  while (i < buf.byteLength) {
    const byte = buf[i++]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) {
      return { value, next: i }
    }
    shift += 7
    if (shift > 35) {
      throw new Error('Varint too long')
    }
  }
  throw new Error('Truncated varint')
}

type ProtoField =
  | { field: number; wireType: 0; value: number }
  | { field: number; wireType: 2; value: Uint8Array<ArrayBufferLike> }

function decodeFields(buf: Uint8Array<ArrayBufferLike>): ProtoField[] {
  const fields: ProtoField[] = []
  let i = 0
  while (i < buf.byteLength) {
    const key = decodeVarint(buf, i)
    i = key.next
    const field = key.value >>> 3
    const wireType = key.value & 7
    if (wireType === 0) {
      const varint = decodeVarint(buf, i)
      i = varint.next
      fields.push({ field, wireType: 0, value: varint.value })
      continue
    }
    if (wireType === 2) {
      const length = decodeVarint(buf, i)
      i = length.next
      const end = i + length.value
      if (end > buf.byteLength) {
        throw new Error('Truncated length-delimited field')
      }
      fields.push({ field, wireType: 2, value: buf.subarray(i, end) })
      i = end
      continue
    }
    if (wireType === 1) {
      if (i + 8 > buf.byteLength) {
        throw new Error('Truncated fixed64 field')
      }
      i += 8
      continue
    }
    if (wireType === 5) {
      if (i + 4 > buf.byteLength) {
        throw new Error('Truncated fixed32 field')
      }
      i += 4
      continue
    }
    throw new Error(`Unsupported protobuf wire type ${wireType}`)
  }
  return fields
}

function decodeTimestampMs(data: Uint8Array<ArrayBufferLike>): number | null {
  const fields = decodeFields(data)
  const seconds = fields.find((entry) => entry.field === 1 && entry.wireType === 0)
  if (!seconds || seconds.wireType !== 0) {
    return null
  }
  return seconds.value * 1000
}

export function decodeRemainingResetTokens(
  payload: Uint8Array<ArrayBufferLike>
): GrokRemainingResetToken[] {
  const tokens: GrokRemainingResetToken[] = []
  for (const entry of decodeFields(payload)) {
    if (entry.field !== 10 || entry.wireType !== 2) {
      continue
    }
    let tokenId: string | null = null
    let grantedAt: number | null = null
    let expiresAt: number | null = null
    for (const inner of decodeFields(entry.value)) {
      if (inner.field === 10 && inner.wireType === 2) {
        tokenId = textDecoder.decode(inner.value)
      } else if (inner.field === 20 && inner.wireType === 2) {
        grantedAt = decodeTimestampMs(inner.value)
      } else if (inner.field === 30 && inner.wireType === 2) {
        expiresAt = decodeTimestampMs(inner.value)
      }
    }
    if (tokenId) {
      tokens.push({ tokenId, grantedAt, expiresAt })
    }
  }
  return tokens
}

export function mapRemainingResetTokens(tokens: GrokRemainingResetToken[]): RateLimitResetCredits {
  const credits = tokens.map((token) => ({
    status: 'available',
    expiresAt: token.expiresAt,
    grantedAt: token.grantedAt
  }))
  const expiries = credits
    .map((credit) => credit.expiresAt)
    .filter((expiresAt): expiresAt is number => typeof expiresAt === 'number')
    .sort((left, right) => left - right)
  return {
    availableCount: tokens.length,
    nextExpiresAt: expiries[0] ?? null,
    ...(credits.length > 0 ? { credits } : {})
  }
}

function parseTrailerBlock(text: string): {
  status: string | null
  message: string | null
} {
  let status: string | null = null
  let message: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) {
      continue
    }
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'grpc-status') {
      status = value
    } else if (key === 'grpc-message') {
      try {
        message = decodeURIComponent(value)
      } catch {
        message = value
      }
    }
  }
  return { status, message }
}

export function parseGrpcWebResponse(
  raw: Uint8Array<ArrayBufferLike>,
  headerStatus?: string | null,
  headerMessage?: string | null
): {
  payload: Uint8Array<ArrayBufferLike>
  grpcStatus: string
  grpcMessage: string | null
} {
  let payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let trailerStatus: string | null = null
  let trailerMessage: string | null = null
  let i = 0
  while (i < raw.byteLength) {
    if (raw.byteLength - i < 5) {
      throw new Error('Truncated gRPC-Web frame header')
    }
    const flags = raw[i]
    const length = raw[i + 1] * 0x1000000 + raw[i + 2] * 0x10000 + raw[i + 3] * 0x100 + raw[i + 4]
    i += 5
    const end = i + length
    if (end > raw.byteLength) {
      throw new Error('Truncated gRPC-Web frame payload')
    }
    const chunk = raw.subarray(i, end)
    i = end
    if (flags & 0x80) {
      const parsed = parseTrailerBlock(textDecoder.decode(chunk))
      trailerStatus = parsed.status
      trailerMessage = parsed.message
      break
    }
    payload = chunk
  }
  const grpcStatus = trailerStatus ?? headerStatus
  if (grpcStatus == null) {
    throw new Error('Missing grpc-status')
  }
  return {
    payload,
    grpcStatus,
    grpcMessage: trailerMessage ?? headerMessage ?? null
  }
}
