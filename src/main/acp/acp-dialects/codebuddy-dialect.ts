import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

const toolMetaSchema = lazyZodSchema(() =>
  z.looseObject({
    _meta: z.looseObject({ 'codebuddy.ai/toolName': z.string().min(1) })
  })
)
const shellResponseSchema = lazyZodSchema(() =>
  z.looseObject({
    rawOutput: z.looseObject({ type: z.literal('text'), text: z.string() }),
    _meta: z.looseObject({
      'codebuddy.ai/toolName': z.literal('Bash'),
      'codebuddy.ai/rawResponse': z.looseObject({ exitCode: z.number().int() })
    })
  })
)
const skillMetaSchema = lazyZodSchema(() =>
  z.looseObject({ _meta: z.looseObject({ type: z.literal('skill') }) })
)

const SHELL_TAIL = /\nExit Code: -?\d+\nSignal: [^\n]*$/u
const STDOUT = 'Stdout: '
const STDERR = '\nStderr: '
const EMPTY_STREAM = '(empty)'

function shellStream(text: string): string {
  const stream = text.replaceAll('\r\n', '\n').trimEnd()
  return stream === EMPTY_STREAM ? '' : stream
}

function shellStreams(text: string): { stdout: string; stderr: string } | null {
  const tail = SHELL_TAIL.exec(text)
  const head = tail ? text.slice(0, tail.index) : ''
  const split = head.lastIndexOf(STDERR)
  if (!head.startsWith(STDOUT) || split === -1) {
    return null
  }
  return {
    stdout: shellStream(head.slice(STDOUT.length, split)),
    stderr: shellStream(head.slice(split + STDERR.length))
  }
}

// While a call's arguments stream, each update carries the newest JSON piece as text, with no
// status or output yet.
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  if (update.status === undefined && update.rawOutput === undefined && update.content) {
    const { content: _arguments, ...rest } = update
    return rest
  }
  const shell = shellResponseSchema.safeParse(update).data
  const streams = shell ? shellStreams(shell.rawOutput.text) : null
  if (!shell || !streams) {
    return update
  }
  // A Bash result is one text record (`Stdout: …\nStderr: …\nExit Code: N\nSignal: …`), repeated
  // as a text block when the call fails, and reported completed whatever its exit code.
  const { exitCode } = shell._meta['codebuddy.ai/rawResponse']
  return {
    ...update,
    status: exitCode === 0 ? update.status : 'failed',
    rawOutput: {
      stdout: streams.stdout,
      ...(streams.stderr ? { stderr: streams.stderr } : {}),
      exitCode
    },
    content: update.content?.filter(
      (block) => !(block.type === 'content' && block.content.type === 'text')
    )
  }
}

export const CODEBUDDY_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  // Titles carry the call's input (`` `ls` ``); the tool itself is in `_meta`.
  toolName: (update) => toolMetaSchema.safeParse(update).data?._meta['codebuddy.ai/toolName'],
  skillDescription: (command) =>
    skillMetaSchema.safeParse(command).success ? command.description : null,
  // A finished background command starts a turn of its own to report it.
  reactiveWakeups: true,
  // Each switches CodeBuddy to a new session under the chat's transcript.
  withheldCommands: ['clear', 'new', 'fork', 'branch']
}
