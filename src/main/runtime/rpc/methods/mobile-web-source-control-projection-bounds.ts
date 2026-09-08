import {
  MobileWebGitObjectIdSchema,
  MobileWebGitRefNameSchema
} from '../../../../shared/mobile-web/source-control-history-contract'

/** Headroom for the envelope the projected page result still has to fit inside. */
export const RESPONSE_BUDGET_RESERVE_BYTES = 8 * 1024

/** A Git string the page contract accepts only in a narrower form. Desktop types guarantee a
 * string, never that it is an object id or a ref name the page schema admits. */
export function gitObjectId(value: string | null | undefined): string | null {
  const parsed = MobileWebGitObjectIdSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function gitRefName(value: string | null | undefined): string | null {
  const parsed = MobileWebGitRefNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function boundedText(value: string | undefined, limit: number): string | undefined {
  return value !== undefined && value.length > 0 ? value.slice(0, limit) : undefined
}

export function encodedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}
