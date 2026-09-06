import { z } from 'zod'

// Copied from relay-contract rather than imported: the push gateway ships as a
// standalone image and must not pull the relay wire contract into its closure.
export const Base64Url32ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const Base6432ByteSchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/)
export const Base64Raw24ByteSchema = z.string().regex(/^(?:[A-Za-z0-9+/]{4}){8}$/)
export const PushHostFingerprintSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/)
export const OpaqueIdSchema = z.string().min(1).max(128)
export const EpochMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const BoundedCiphertextSchema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

export const CanonicalHttpsOriginSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && url.pathname === '/'
  } catch {
    return false
  }
}, 'must be a canonical HTTPS origin')
