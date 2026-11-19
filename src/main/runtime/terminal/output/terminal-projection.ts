import type { RuntimeTerminalRowMetadata } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

export type RuntimeTerminalProjection = {
  lines: string[]
  draft?: string
  tailRows?: RuntimeTerminalRowMetadata[]
  /** Set when read from the hidden renderer: its trust token at the read, for revalidation at use. */
  rendererToken?: number
  /** Coverage measured independently of a stream that missed output. */
  historyCut?: boolean
}
