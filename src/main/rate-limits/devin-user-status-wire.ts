// Wire codec for the Devin CLI's SeatManagementService/GetUserStatus call.
//
// Why: Devin ships no REST quota endpoint. The CLI asks the Cascade backend
// (server.codeium.com) for user status via a unary Connect-RPC call whose body
// is raw (unframed) protobuf — `exa.seat_management_pb.GetUserStatusRequest`
// carrying a `codeium_common_pb.Metadata` with the CLI identity tuple and the
// session token from credentials.toml. The backend gates the CLI surface on
// that identity (ide_name=devin-cli, ide_type=chisel), so a bare token call is
// rejected. Field numbers below follow the published exa/codeium proto schema.

const DEVIN_CLI_IDE_NAME = 'devin-cli'
const DEVIN_CLI_IDE_TYPE = 'chisel'
const DEVIN_CLI_EXTENSION_NAME = 'chisel'
const DEVIN_CLI_LOCALE = 'en'

export type DevinUserStatusQuota = {
  /** 0–100 remaining for the daily quota window, when reported. */
  dailyQuotaRemainingPercent: number | null
  /** 0–100 remaining for the weekly quota window, when reported. */
  weeklyQuotaRemainingPercent: number | null
  /** Unix seconds when the daily window resets. */
  dailyQuotaResetAtUnix: number | null
  /** Unix seconds when the weekly window resets. */
  weeklyQuotaResetAtUnix: number | null
  /** Plan display name (e.g. "Pro") from plan_status.plan_info.plan_name. */
  planName: string | null
  /** Account email, for provenance labelling. */
  email: string | null
}

type ProtoField =
  | { num: number; wire: 0; value: bigint }
  | { num: number; wire: 1 | 5; value: Uint8Array }
  | { num: number; wire: 2; value: Uint8Array }

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = []
  let v = value >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Uint8Array.from(bytes)
}

function encodeStringField(num: number, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  const tag = encodeVarint((num << 3) | 2)
  const len = encodeVarint(bytes.length)
  const out = new Uint8Array(tag.length + len.length + bytes.length)
  out.set(tag, 0)
  out.set(len, tag.length)
  out.set(bytes, tag.length + len.length)
  return out
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// Builds GetUserStatusRequest{metadata{…}} — the only message member the
// request schema defines (field 1, length-delimited).
export function encodeGetUserStatusRequest(sessionToken: string, cliVersion: string): Uint8Array {
  const metadata = concatBytes([
    encodeStringField(1, DEVIN_CLI_IDE_NAME), // ide_name
    encodeStringField(2, cliVersion), // extension_version
    encodeStringField(3, sessionToken), // api_key — wire format carries the devin-session-token$ prefix
    encodeStringField(4, DEVIN_CLI_LOCALE), // locale
    encodeStringField(
      5,
      process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'
    ), // os
    encodeStringField(7, cliVersion), // ide_version
    encodeStringField(12, DEVIN_CLI_EXTENSION_NAME), // extension_name
    encodeStringField(28, DEVIN_CLI_IDE_TYPE) // ide_type — 'chisel' unlocks the Devin CLI surface
  ])
  const tag = encodeVarint(0x0a) // field 1, wire 2
  const len = encodeVarint(metadata.length)
  return concatBytes([tag, len, metadata])
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  while (pos < buf.length) {
    const byte = buf[pos++]
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      return [result, pos]
    }
    shift += 7n
  }
  throw new Error('truncated varint')
}

function readProtoFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let pos = 0
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos)
    pos = afterTag
    const num = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      const [value, next] = readVarint(buf, pos)
      pos = next
      fields.push({ num, wire: 0, value })
    } else if (wire === 2) {
      const [len, afterLen] = readVarint(buf, pos)
      const length = Number(len)
      pos = afterLen + length
      if (pos > buf.length) {
        throw new Error('truncated length-delimited field')
      }
      fields.push({ num, wire: 2, value: buf.subarray(afterLen, pos) })
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4
      if (pos + size > buf.length) {
        throw new Error('truncated fixed-width field')
      }
      fields.push({ num, wire, value: buf.subarray(pos, pos + size) })
      pos += size
    } else {
      // Why: wire types 3/4 (groups) are unused in proto3 output; bail rather
      // than silently misaligning the rest of the message.
      throw new Error(`unsupported protobuf wire type ${wire}`)
    }
  }
  return fields
}

function fieldBytes(fields: ProtoField[], num: number): Uint8Array | null {
  const field = fields.find((f) => f.num === num)
  return field?.wire === 2 ? field.value : null
}

function fieldVarint(fields: ProtoField[], num: number): number | null {
  const field = fields.find((f) => f.num === num)
  return field?.wire === 0 ? Number(field.value) : null
}

function fieldString(fields: ProtoField[], num: number): string | null {
  const bytes = fieldBytes(fields, num)
  return bytes ? new TextDecoder().decode(bytes) : null
}

// Parses GetUserStatusResponse → user_status.plan_status quota fields plus the
// plan/account labels the status bar shows. Returns null when the payload is
// not a decodable user-status message.
export function decodeGetUserStatusQuota(buf: Uint8Array): DevinUserStatusQuota | null {
  let userStatusBytes: Uint8Array | null
  try {
    userStatusBytes = fieldBytes(readProtoFields(buf), 1)
  } catch {
    return null
  }
  if (!userStatusBytes) {
    return null
  }
  let userStatus: ProtoField[]
  let planStatusBytes: Uint8Array | null
  try {
    userStatus = readProtoFields(userStatusBytes)
    planStatusBytes = fieldBytes(userStatus, 13)
  } catch {
    return null
  }
  if (!planStatusBytes) {
    return null
  }
  let planStatus: ProtoField[]
  try {
    planStatus = readProtoFields(planStatusBytes)
  } catch {
    return null
  }
  const planInfoBytes = fieldBytes(planStatus, 1)
  let planName: string | null = null
  if (planInfoBytes) {
    try {
      planName = fieldString(readProtoFields(planInfoBytes), 2)
    } catch {
      planName = null
    }
  }
  return {
    dailyQuotaRemainingPercent: fieldVarint(planStatus, 14),
    weeklyQuotaRemainingPercent: fieldVarint(planStatus, 15),
    dailyQuotaResetAtUnix: fieldVarint(planStatus, 17),
    weeklyQuotaResetAtUnix: fieldVarint(planStatus, 18),
    planName,
    email: fieldString(userStatus, 7)
  }
}
