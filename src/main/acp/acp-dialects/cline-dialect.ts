import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

// Each built-in tool runs a batch (commands, files, queries) and reports one entry per item.
const batchEntrySchema = lazyZodSchema(() =>
  z.looseObject({
    result: z.string(),
    error: z.string().optional(),
    success: z.boolean().optional()
  })
)
const batchSchema = lazyZodSchema(() => z.array(batchEntrySchema).min(1))
const commandsInputSchema = lazyZodSchema(() =>
  z.looseObject({ commands: z.array(z.string()).min(1) })
)
const EXIT_LINE = /^\[Command exited with code (-?\d+)\](?:\n|$)/u

// The editor and apply_patch report a single entry; a reopen replays any of them as JSON text,
// one entry per line.
function batchEntries(output: unknown): z.infer<typeof batchSchema> | undefined {
  try {
    const items =
      typeof output === 'string' ? output.split('\n').map((line) => JSON.parse(line)) : output
    return batchSchema.safeParse(Array.isArray(items) ? items : [items]).data
  } catch {
    return undefined
  }
}

// A failed command's result opens with its exit line; the first non-zero code is the batch's.
function batchOutput(entries: z.infer<typeof batchSchema>): { stdout: string; exitCode?: number } {
  let exitCode: number | undefined
  const stdout = entries
    .map((entry) => {
      const exit = EXIT_LINE.exec(entry.result)
      if (exit) {
        exitCode ||= Number(exit[1])
      }
      return entry.result.slice(exit?.[0].length ?? 0) || entry.error
    })
    .filter(Boolean)
    .join('\n')
  return exitCode === undefined ? { stdout } : { stdout, exitCode }
}

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const commands = commandsInputSchema.safeParse(update.rawInput).data?.commands
  const entries = batchEntries(update.rawOutput)
  return {
    ...update,
    ...(commands ? { rawInput: { command: commands.join('\n') } } : {}),
    ...(entries ? { rawOutput: batchOutput(entries) } : {}),
    // A batch reports completed even when an item in it failed.
    ...(update.status === 'completed' && entries?.some((entry) => entry.success === false)
      ? { status: 'failed' as const }
      : {})
  }
}

// No interactionModes: Cline 3.0.75 applies a Plan/Act change only when a session starts.
export const CLINE_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  // 3.0.75 keeps only a prompt's text blocks.
  dropsPromptImages: true,
  // Titles are `<tool>: <preview>`.
  toolName: (update) => update.title?.split(': ', 1)[0]
}
