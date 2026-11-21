import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

const SHELL_EXIT_LINE = /(?:^|\n)\[Process exited with code (-?\d+)\]$/u
const SHELL_FAILURE_LINE = /^Error: Command failed \(exit code: -?\d+\)(?:\n|$)/u
const SHELL_SILENT_SUCCESS = 'Command completed successfully'

// Execute's result is one string: output, then an exit line; a failure also opens with an error line.
function shellResult(output: string): { stdout: string; exitCode: number } | null {
  const exit = SHELL_EXIT_LINE.exec(output)
  if (!exit) {
    return null
  }
  // Trimmed by hand: a regex over a long run of blank lines backtracks quadratically.
  let end = exit.index
  while (end > 0 && output[end - 1] === '\n') {
    end--
  }
  const stdout = output.slice(0, end).replace(SHELL_FAILURE_LINE, '')
  return { stdout: stdout === SHELL_SILENT_SUCCESS ? '' : stdout, exitCode: Number(exit[1]) }
}

// The result string is repeated as a text block.
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const output = update.rawOutput
  const shell =
    typeof output === 'string' && (update.status === 'completed' || update.status === 'failed')
      ? shellResult(output)
      : null
  if (!shell) {
    return update
  }
  return {
    ...update,
    rawOutput: shell,
    content: update.content?.filter(
      (block) =>
        !(
          block.type === 'content' &&
          block.content.type === 'text' &&
          block.content.text === output
        )
    )
  }
}

export const DROID_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  // Droid's commands are all skills: its own, the user's and the project's.
  skillDescription: ({ description }) => description
}
