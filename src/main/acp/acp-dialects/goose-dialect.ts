import { z } from 'zod'
import type { AgentJournalPromptIntent } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { AcpDialect, AcpRequestPresentation } from './acp-dialect'

const gooseShellOutputSchema = z.looseObject({
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int()
})

const gooseToolCallMetaSchema = z.looseObject({
  goose: z.looseObject({ toolCall: z.looseObject({ toolName: z.string().min(1) }) })
})

// Goose's own refusals when no provider, model or key is configured.
const NOT_CONFIGURED =
  /^(?:Failed to resolve provider and model|Error getting agent reply): Configuration value not found: /u

// Shell results carry `exit_code`; the text keeps Goose's interleaved output and notices (timeout,
// truncation) and ends a failure with an exit line, which the exit code replaces.
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const result = gooseShellOutputSchema.safeParse(update.rawOutput).data
  if (!result) {
    return update
  }
  const trailer = `\n\nCommand exited with code ${result.exit_code}`
  return {
    ...update,
    rawOutput: { ...result, exitCode: result.exit_code },
    content: update.content?.map((block) =>
      block.type === 'content' &&
      block.content.type === 'text' &&
      block.content.text.endsWith(trailer)
        ? {
            ...block,
            content: { ...block.content, text: block.content.text.slice(0, -trailer.length) }
          }
        : block
    )
  }
}

const OPTION_LABELS: Record<AgentJournalPromptIntent, string> = {
  allow_once: 'Allow',
  allow_always: 'Always allow',
  reject_once: 'Deny',
  reject_always: 'Always deny'
}

// Goose names each approval option by its kind's id, e.g. `allow_once`.
function approvalRequest(method: string, params: unknown): AcpRequestPresentation | undefined {
  if (method !== 'session/request_permission') {
    return undefined
  }
  const presentation = acpPermissionPresentation(params)
  const { body } = presentation
  return body.kind === 'approval'
    ? {
        ...presentation,
        body: {
          ...body,
          options: body.options.map((option) =>
            option.intent && option.label === option.id
              ? { ...option, label: OPTION_LABELS[option.intent] }
              : option
          )
        }
      }
    : presentation
}

export const GOOSE_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  // Titles are `<tool> · <preview>`, and Goose may later replace them with a generated summary.
  toolName: (update) =>
    gooseToolCallMetaSchema.safeParse(update._meta).data?.goose.toolCall.toolName,
  request: approvalRequest,
  authenticationRequired: (error) =>
    error.code === -32603 && typeof error.data === 'string' && NOT_CONFIGURED.test(error.data),
  // /clear would empty the session under the chat's transcript.
  withheldCommands: ['clear']
}
