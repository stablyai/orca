import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'
import { reportsNoApiKey } from './omp-dialect'

const SHELL_FAILURE = /^(?:([\s\S]*)\n\n)?Command exited with code (-?\d+)$/u

// A failed bash call's text is its output, then Pi's exit line; a successful one has no exit line.
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const block =
    update.status === 'failed' && update.content?.length === 1 ? update.content[0] : null
  const text =
    block?.type === 'content' && block.content.type === 'text' ? block.content.text : null
  const failure = text === null ? null : SHELL_FAILURE.exec(text)
  if (!failure) {
    return update
  }
  return {
    ...update,
    rawOutput: { stdout: failure[1] ?? '', exitCode: Number(failure[2]) },
    content: []
  }
}

export const AUGGIE_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  authenticationRequired: reportsNoApiKey
}
