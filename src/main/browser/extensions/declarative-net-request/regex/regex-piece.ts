// A translated piece of an RE2 pattern: its JS source plus what the checks around it need.

export type Piece = {
  src: string
  /** Approximate RE2 instruction count. */
  cost: number
  /** Set when the piece is one literal character (lower-cased). */
  char: string | null
  /** Longest literal every match contains (lower-cased). */
  literal: string
  assertion: boolean
  /** Can match the empty string. */
  nullable: boolean
  /** V8 linear engine's replication factor of the most nested quantifier inside. */
  replication: number
}

/** RE2 instructions allowed by Chromium's 2KB max_mem: (2048 * 2/3 - sizeof(Prog)) / 8. */
export const MAX_PROGRAM_SIZE = 116

/** Thrown for patterns RE2 refuses or JS cannot run the same way. */
export class Refusal extends Error {}

export const refuse = (): never => {
  throw new Refusal()
}

export const piece = (src: string, cost: number, assertion = false): Piece => ({
  src,
  cost,
  char: null,
  literal: '',
  assertion,
  nullable: assertion,
  replication: 1
})

/** `part` appended to `whole`, except the source, literal and char. */
export const joined = (whole: Piece, part: Piece): Piece => ({
  ...whole,
  cost: whole.cost + part.cost,
  nullable: whole.nullable && part.nullable,
  replication: Math.max(whole.replication, part.replication)
})
