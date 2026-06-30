import type { PipelinePromptDefinition } from '../../shared/pipeline-template-types'
import type { PipelineDb } from './db'
import { runDynamicContextCommand } from './dynamic-context-command-runner'

export type PipelinePromptArgs = Record<string, string | number | boolean>

export type PipelineDynamicContextCommandInput = {
  command: string
  cwd: string
  timeoutMs: number
  maxStdoutChars: number
  maxStderrChars: number
}

export type PipelineDynamicContextCommandResult = {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export type PipelineDynamicContextCommandRunner = (
  input: PipelineDynamicContextCommandInput
) => Promise<PipelineDynamicContextCommandResult>

export type PipelinePromptRenderWarning = {
  code: 'unused_prompt_arg'
  key: string
}

export type PipelinePromptRenderResult = {
  prompt: string
  warnings: PipelinePromptRenderWarning[]
}

export type PipelinePromptRenderInput = {
  prompt: PipelinePromptDefinition
  builtInArgs?: PipelinePromptArgs
  userArgs?: PipelinePromptArgs
  cwd: string
  runId?: string
  stageId?: string | null
  templateId?: string
  db?: PipelineDb
  commandRunner?: PipelineDynamicContextCommandRunner
  timeoutMs?: number
  maxStdoutChars?: number
  maxStderrChars?: number
}

export class PipelinePromptRenderError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PipelinePromptRenderError'
    this.code = code
    this.details = details
  }
}

const SHELL_BLOCK_MARKER = '\x01'
const RAW_SHELL_BLOCK_PATTERN = /!`([^`]+)`/g
const MARKED_SHELL_BLOCK_PATTERN = new RegExp(`!${SHELL_BLOCK_MARKER}\`([^\`]+)\``, 'g')
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const BUILT_IN_PROMPT_ARG_KEYS = new Set([
  'SOURCE_BRANCH',
  'TARGET_BRANCH',
  'TASK_ID',
  'ISSUE_TITLE',
  'BRANCH',
  'VIEW_TASK_COMMAND',
  'LIST_TASKS_COMMAND',
  'CLOSE_TASK_COMMAND',
  'BRANCHES',
  'ISSUES'
])

export async function renderPipelinePrompt(
  input: PipelinePromptRenderInput
): Promise<PipelinePromptRenderResult> {
  const builtInArgs = input.builtInArgs ?? {}
  const userArgs = input.userArgs ?? {}
  validatePromptArgs(input.prompt, builtInArgs, userArgs)

  const rawText = input.prompt.source.text.replaceAll(SHELL_BLOCK_MARKER, '')
  const markedPrompt = markRawShellBlocks(rawText)
  validateDynamicContextPlaceholders(markedPrompt, builtInArgs, userArgs)

  const args = sanitizePromptArgs({ ...userArgs, ...builtInArgs })
  const warnings = findUnusedArgs(markedPrompt, args)
  const substituted = substituteArgs(markedPrompt, args)
  const prompt = await expandDynamicContext(substituted, input)

  return { prompt: prompt.replaceAll(SHELL_BLOCK_MARKER, ''), warnings }
}

async function expandDynamicContext(
  prompt: string,
  input: PipelinePromptRenderInput
): Promise<string> {
  const matches = [...prompt.matchAll(MARKED_SHELL_BLOCK_PATTERN)]
  if (matches.length === 0) {
    return prompt
  }

  const runner = input.commandRunner ?? runDynamicContextCommand
  const replacements: string[] = []
  for (const match of matches) {
    const command = match[1]!
    const result = truncateCommandResult(
      await runner({
        command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? 30_000,
        maxStdoutChars: input.maxStdoutChars ?? 32_000,
        maxStderrChars: input.maxStderrChars ?? 8_000
      }),
      input
    )
    recordDynamicContextResult(input, command, result)
    if (result.timedOut) {
      throw new PipelinePromptRenderError(
        'dynamic_context_timeout',
        `Command timed out: ${command}`,
        {
          command
        }
      )
    }
    if (result.exitCode !== 0) {
      throw new PipelinePromptRenderError(
        'dynamic_context_failed',
        `Command exited with code ${result.exitCode}: ${command}`,
        { command, exitCode: result.exitCode, stderr: result.stderr }
      )
    }
    replacements.push(result.stdout.trimEnd())
  }

  let rendered = prompt
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!
    rendered =
      rendered.slice(0, match.index!) +
      replacements[i] +
      rendered.slice(match.index! + match[0].length)
  }
  return rendered
}

function validatePromptArgs(
  prompt: PipelinePromptDefinition,
  builtInArgs: PipelinePromptArgs,
  userArgs: PipelinePromptArgs
): void {
  const hasArgs = Object.keys(builtInArgs).length > 0 || Object.keys(userArgs).length > 0
  if (prompt.source.type === 'inline' && hasArgs) {
    throw new PipelinePromptRenderError(
      'inline_prompt_args',
      'Inline prompts do not accept prompt args'
    )
  }
  for (const key of Object.keys(userArgs)) {
    if (BUILT_IN_PROMPT_ARG_KEYS.has(key) || key in builtInArgs) {
      throw new PipelinePromptRenderError(
        'built_in_arg_override',
        `"${key}" is a built-in prompt argument and cannot be overridden`,
        { key }
      )
    }
  }
}

function validateDynamicContextPlaceholders(
  markedPrompt: string,
  builtInArgs: PipelinePromptArgs,
  userArgs: PipelinePromptArgs
): void {
  for (const match of markedPrompt.matchAll(MARKED_SHELL_BLOCK_PATTERN)) {
    const commandTemplate = match[1]!
    for (const placeholder of commandTemplate.matchAll(PLACEHOLDER_PATTERN)) {
      const key = placeholder[1]!
      if (key in userArgs || !(key in builtInArgs)) {
        throw new PipelinePromptRenderError(
          'dynamic_context_user_arg',
          `Dynamic context command placeholder "{{${key}}}" must be a built-in arg`,
          { key }
        )
      }
    }
  }
}

function markRawShellBlocks(prompt: string): string {
  return prompt.replace(RAW_SHELL_BLOCK_PATTERN, `!${SHELL_BLOCK_MARKER}\`$1\``)
}

function sanitizePromptArgs(args: PipelinePromptArgs): PipelinePromptArgs {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.replaceAll(SHELL_BLOCK_MARKER, '') : value
    ])
  )
}

function substituteArgs(prompt: string, args: PipelinePromptArgs): string {
  const referenced = new Set([...prompt.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!))
  for (const key of referenced) {
    if (!(key in args)) {
      throw new PipelinePromptRenderError(
        'missing_prompt_arg',
        `Prompt argument "{{${key}}}" has no matching value`,
        { key }
      )
    }
  }
  return prompt.replace(PLACEHOLDER_PATTERN, (_match, key: string) => String(args[key]))
}

function findUnusedArgs(prompt: string, args: PipelinePromptArgs): PipelinePromptRenderWarning[] {
  const referenced = new Set([...prompt.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!))
  return Object.keys(args)
    .filter((key) => !referenced.has(key))
    .map((key) => ({ code: 'unused_prompt_arg', key }))
}

function truncateCommandResult(
  result: PipelineDynamicContextCommandResult,
  input: PipelinePromptRenderInput
): PipelineDynamicContextCommandResult & {
  stdoutTruncated: boolean
  stderrTruncated: boolean
} {
  const stdout = truncateText(result.stdout, input.maxStdoutChars ?? 32_000)
  const stderr = truncateText(result.stderr, input.maxStderrChars ?? 8_000)
  return {
    ...result,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated
  }
}

function recordDynamicContextResult(
  input: PipelinePromptRenderInput,
  command: string,
  result: PipelineDynamicContextCommandResult & {
    stdoutTruncated: boolean
    stderrTruncated: boolean
  }
): void {
  if (!input.db || !input.runId) {
    return
  }
  input.db.recordDynamicContextResult({
    runId: input.runId,
    stageId: input.stageId ?? null,
    templateId: input.templateId ?? input.prompt.id,
    command,
    cwd: input.cwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated
  })
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false }
}
