import type { RuntimeTerminalRowMetadata } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

export type RuntimeTerminalProjection = {
  lines: string[]
  draft?: string
  tailRows?: RuntimeTerminalRowMetadata[]
}
