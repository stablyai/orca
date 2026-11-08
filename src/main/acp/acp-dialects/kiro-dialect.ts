import { fileURLToPath } from 'node:url'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

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
  normalizeToolUpdate
}
