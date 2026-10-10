import { z } from 'zod'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

// OpenCode reports a command's output and exit code under `rawOutput.metadata`; the shared shape
// is `stdout` and `exitCode`.
const commandRawOutputSchema = z.looseObject({
  output: z.unknown().optional(),
  metadata: z
    .looseObject({
      exit: z.number().int().nullable().optional(),
      output: z.string().optional()
    })
    .optional()
})

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const parsed = commandRawOutputSchema.safeParse(update.rawOutput)
  if (!parsed.success) {
    return update
  }
  const rawOutput = parsed.data
  const output =
    typeof rawOutput.output === 'string' ? rawOutput.output : rawOutput.metadata?.output
  const hasSharedOutput = ['stdout', 'stderr', 'output_for_prompt'].some(
    (key) => rawOutput[key] !== undefined
  )
  const hasSharedExitCode = rawOutput.exitCode !== undefined || rawOutput.exit_code !== undefined
  const exitCode = rawOutput.metadata?.exit ?? undefined
  if ((output === undefined || hasSharedOutput) && (exitCode === undefined || hasSharedExitCode)) {
    return update
  }
  return {
    ...update,
    rawOutput: {
      ...rawOutput,
      ...(output === undefined || hasSharedOutput ? {} : { stdout: output }),
      ...(exitCode === undefined || hasSharedExitCode ? {} : { exitCode })
    }
  }
}

export const OPENCODE_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate
}
