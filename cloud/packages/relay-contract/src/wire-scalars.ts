import { z } from 'zod'

export const Base64Url32ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const Base64Url24ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/)
export const Base6432ByteSchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/)
export const Base64Raw24ByteSchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4}){8}$/)
export const RelayHostIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/)
export const OpaqueIdSchema = z.string().min(1).max(128)
export const EpochMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const GenerationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const PositiveDurationMsSchema = z.number().int().positive().max(24 * 60 * 60 * 1000)

export const CanonicalHttpsOriginSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && url.pathname === '/'
  } catch {
    return false
  }
}, 'must be a canonical HTTPS origin')
