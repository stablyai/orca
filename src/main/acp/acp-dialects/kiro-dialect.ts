import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

const skillMetaSchema = lazyZodSchema(() =>
  z.looseObject({
    _meta: z.looseObject({ kiro: z.looseObject({ type: z.literal('skill') }) })
  })
)

// Kiro's V3 engine names a diff's file with a file:// URI where ACP expects a path.
function diffPath(path: string): string {
  if (!path.startsWith('file:')) {
    return path
  }
  try {
    return fileURLToPath(path)
  } catch {
    return path
  }
}

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const content = update.content
  if (!content?.some((block) => block.type === 'diff' && block.path.startsWith('file:'))) {
    return update
  }
  return {
    ...update,
    content: content.map((block) =>
      block.type === 'diff' ? { ...block, path: diffPath(block.path) } : block
    )
  }
}

export const KIRO_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  skillDescription: (command) =>
    skillMetaSchema.safeParse(command).success ? command.description : null,
  // Kiro runs user hooks only for ACP clients that opt in at initialize, as its own TUI does.
  clientCapabilities: { _meta: { kiro: { hooks: { enabled: true, v2: true } } } }
}
