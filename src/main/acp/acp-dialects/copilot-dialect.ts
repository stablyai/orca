import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

const copilotToolResultSchema = lazyZodSchema(() =>
  z.looseObject({
    content: z.string(),
    contents: z
      .array(z.looseObject({ type: z.string(), exitCode: z.number().int().optional() }))
      .optional()
  })
)

const SHELL_EXIT_TRAILER = /\n?<shellId: [^>\n]+ completed with exit code -?\d+>\s*$/u

// Results arrive as { content, detailedContent, contents } and repeat `content` as a text block.
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const result = copilotToolResultSchema.safeParse(update.rawOutput).data
  if (!result) {
    return update
  }
  const exitCode = result.contents?.find((entry) => entry.type === 'shell_exit')?.exitCode
  const stdout =
    exitCode === undefined ? result.content : result.content.replace(SHELL_EXIT_TRAILER, '')
  return {
    ...update,
    rawOutput: { stdout, ...(exitCode === undefined ? {} : { exitCode }) },
    content: update.content?.filter(
      (block) =>
        !(
          block.type === 'content' &&
          block.content.type === 'text' &&
          block.content.text === result.content
        )
    )
  }
}

// Copilot lists skills among its commands, each with this input hint whatever its own.
const SKILL_INPUT_HINT = 'instructions for the skill'

export const COPILOT_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  skillDescription: ({ description, input }) =>
    input?.hint === SKILL_INPUT_HINT ? description : null,
  // These switch Copilot to approving everything itself, behind the chat's permission mode.
  withheldCommands: ['allow-all', 'permissions', 'autopilot']
}
