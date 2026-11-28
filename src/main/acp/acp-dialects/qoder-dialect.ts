import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { ToolCallContent, ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

const toolMetaSchema = lazyZodSchema(() =>
  z.looseObject({ _meta: z.looseObject({ qoder: z.looseObject({ toolName: z.string().min(1) }) }) })
)
const commandInputSchema = lazyZodSchema(() => z.looseObject({ command: z.string() }))

// Qoder's ACP advertises only these built-ins; every other command is a skill, plugin or prompt.
const BUILTIN_COMMANDS: ReadonlySet<string> = new Set(['goal', 'rewind', 'rename'])

// A failed shell call opens its result with the exit status (and signal) lines.
const SHELL_EXIT_STATUS = /^Exit code (-?\d+)(?:\nSignal: [^\n]*)?(?:\n|$)/u
const FENCE_OPENING = /^(`{3,})[^\n`]*\n/u

/** The text inside one whole markdown code fence, or null. */
function fencedText(text: string): string | null {
  const opening = FENCE_OPENING.exec(text)
  const closing = opening ? `\n${opening[1]}` : null
  return opening && closing && text.endsWith(closing)
    ? text.slice(opening[0].length, Math.max(opening[0].length, text.length - closing.length))
    : null
}

// Results arrive twice: `rawOutput` as a string and a text block fencing it (shell, Read, errors).
// A pending shell call's text block only repeats its command.
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const output = update.rawOutput
  const command = commandInputSchema.safeParse(update.rawInput).data?.command
  const repeats = (block: ToolCallContent): boolean => {
    if (block.type !== 'content' || block.content.type !== 'text') {
      return false
    }
    if (typeof output === 'string') {
      return fencedText(block.content.text)?.trimEnd() === output.trimEnd()
    }
    return output === undefined && block.content.text === command
  }
  const content = update.content?.filter((block) => !repeats(block))
  const failure =
    update.status === 'failed' && typeof output === 'string' ? shellFailure(output) : null
  if (content?.length === update.content?.length && !failure) {
    return update
  }
  return { ...update, ...(content ? { content } : {}), ...(failure ? { rawOutput: failure } : {}) }
}

function shellFailure(output: string): { stdout: string; exitCode: number } | null {
  const exit = SHELL_EXIT_STATUS.exec(output)
  return exit ? { stdout: output.slice(exit[0].length), exitCode: Number(exit[1]) } : null
}

export const QODER_ACP_DIALECT: AcpDialect = {
  // Its AskUserQuestion rides standard ACP elicitation; without the form cap Qoder disables it.
  clientCapabilities: { elicitation: { form: {} } },
  normalizeToolUpdate,
  // Titles carry the call's input (the command, `Write <path>`); the tool itself is in `_meta`.
  toolName: (update) => toolMetaSchema.safeParse(update).data?._meta.qoder.toolName,
  skillDescription: (command) => (BUILTIN_COMMANDS.has(command.name) ? null : command.description),
  // A finished background command starts a turn of its own to report it (checked live on 1.1.100).
  reactiveWakeups: true,
  // /rewind rewrites the conversation and files under the chat's transcript.
  withheldCommands: ['rewind']
}
