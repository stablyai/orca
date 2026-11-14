import type { RuntimeTerminalRowMetadata } from '../../../../shared/runtime-terminal-contracts'

export type RuntimeTerminalProjection = {
  lines: string[]
  draft?: string
  tailRows?: RuntimeTerminalRowMetadata[]
}
