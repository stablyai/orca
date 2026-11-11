import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export type AntigravityTranscriptToolCall = {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

export type AntigravityTranscriptStep = {
  step_index?: number
  type?: string
  status?: string
  content?: string
  thinking?: string
  tool_calls?: AntigravityTranscriptToolCall[]
}

export type AntigravitySettledTaskMessage = {
  sender?: string
  stepIndex?: number
  toolCallId?: string
  content: string
  mtimeMs: number
}

const transcriptStepSchema: z.ZodType<AntigravityTranscriptStep> = z.looseObject({
  step_index: z.number().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  tool_calls: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        name: z.string().optional(),
        args: z.record(z.string(), z.unknown()).optional()
      })
    )
    .optional()
})

const taskMessageFileSchema = z.looseObject({
  sender: z.string().optional(),
  content: z.string().optional(),
  sourceMetadata: z
    .looseObject({
      tool: z
        .looseObject({
          stepIndex: z.number().optional(),
          toolCall: z.looseObject({ id: z.string().optional() }).optional()
        })
        .optional()
    })
    .optional()
})

/** Strip `Created At:` / `Completed At:` header lines prepended by `agy` tool output. */
export function cleanAntigravityToolOutput(raw: string | undefined): string {
  if (!raw) {
    return ''
  }
  return raw.replace(/^Created At:[^\n]*\n(?:Completed At:[^\n]*\n)?/, '')
}

/** Parse a shell exit code from `agy` command output when present. */
export function parseAntigravityExitCode(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined
  }
  const match = raw.match(/Command exited with code (-?\d+)\./)
  return match ? Number(match[1]) : undefined
}

/** Extract the background task identifier from a `GENERIC` `RUNNING` transcript step. */
export function parseAntigravityTaskId(sessionId: string, step: AntigravityTranscriptStep): string {
  const match =
    typeof step.content === 'string'
      ? step.content.match(/background task with task id:\s*([^\s"]+)/)
      : null
  return match?.[1] ?? `${sessionId}/task-${step.step_index ?? 0}`
}

/** Extract the command string from `agy` tool input regardless of field casing. */
export function extractAntigravityCommand(
  obj: Record<string, unknown> | undefined
): string | undefined {
  const cmd = obj?.CommandLine ?? obj?.command_line ?? obj?.commandLine ?? obj?.command
  return typeof cmd === 'string' ? cmd : undefined
}

/** Classify an `agy` transcript tool name into its corresponding ACP tool kind. */
export function classifyAntigravityToolKind(
  name: string | undefined
): 'execute' | 'read' | 'edit' | 'other' {
  if (name === 'run_command') {
    return 'execute'
  }
  if (name === 'read_file' || name === 'view_file') {
    return 'read'
  }
  if (name === 'edit_file' || name === 'write_file') {
    return 'edit'
  }
  return 'other'
}

/** Build a stable signature for matching transcript tool calls against replayed ACP updates. */
export function antigravityToolSignature(
  kind: string | undefined,
  name: string | undefined,
  rawInput: Record<string, unknown> | undefined
): string {
  const cmd = extractAntigravityCommand(rawInput)
  if (cmd !== undefined) {
    return `exec:${cmd}`
  }
  const pathVal = rawInput?.Path ?? rawInput?.path
  if (typeof pathVal === 'string') {
    return `file:${name ?? kind ?? ''}:${pathVal}`
  }
  const action = rawInput?.Action ?? rawInput?.action
  if (typeof action === 'string') {
    return `act:${name ?? ''}:${action}:${String(rawInput?.TaskId ?? '')}`
  }
  return `other:${name ?? kind ?? ''}:${JSON.stringify(rawInput ?? {})}`
}

/** Summarize a settled background task message into an Orca background-task row status. */
export function summarizeAntigravityBgCompletion(content: string): {
  state: 'done' | 'blocked' | 'idle'
  summary: string
} {
  if (/was canceled|Tool execution was canceled/i.test(content)) {
    return { state: 'idle', summary: 'Canceled' }
  }
  const exitCode = parseAntigravityExitCode(content)
  if (exitCode !== undefined && exitCode !== 0) {
    return { state: 'blocked', summary: `Exited with code ${exitCode}` }
  }
  return {
    state: 'done',
    summary: exitCode === 0 ? 'Completed (exit code 0)' : 'Completed'
  }
}

/** Incrementally tail `agy` conversation transcripts and settled task message files on disk. */
export class AntigravityTranscriptReader {
  private transcriptFilePath: string | null = null
  private transcriptByteOffset = 0
  private transcriptLineCursor = 0
  transcriptMtimeMs = 0
  maxStepIndex = -1
  stepStateReset = false
  readonly stepsByIndex = new Map<number, AntigravityTranscriptStep>()
  readonly rejectedStepIndices = new Set<number>()
  readonly rejectedGenericStepIndices = new Set<number>()
  readonly parsedMessages = new Map<string, AntigravitySettledTaskMessage>()
  readonly settledTasks = new Map<string, AntigravitySettledTaskMessage>()
  readonly killedTaskIds = new Set<string>()

  /** Refresh both the JSONL step transcript and settled background task messages from `sysDir`. */
  async refresh(sysDir: string, onLauncherToolId: (toolCallId: string) => void): Promise<void> {
    await this.refreshTranscript(sysDir)
    await this.refreshMessages(sysDir, onLauncherToolId)
  }

  /** Read newly appended complete JSONL lines from `transcript_full.jsonl` or `transcript.jsonl`. */
  private async refreshTranscript(sysDir: string): Promise<void> {
    const fullPath = join(sysDir, 'logs', 'transcript_full.jsonl')
    const compactPath = join(sysDir, 'logs', 'transcript.jsonl')
    const chosenStat = await stat(fullPath)
      .then((st) => ({ path: fullPath, st }))
      .catch(() =>
        stat(compactPath)
          .then((st) => ({ path: compactPath, st }))
          .catch(() => null)
      )
    if (!chosenStat) {
      return
    }
    const { path: chosen, st } = chosenStat
    if (this.transcriptFilePath !== chosen) {
      this.transcriptFilePath = chosen
      this.transcriptByteOffset = 0
      this.transcriptLineCursor = 0
    }
    this.transcriptMtimeMs = st.mtimeMs
    if (st.size < this.transcriptByteOffset) {
      this.transcriptByteOffset = 0
      this.transcriptLineCursor = 0
      this.maxStepIndex = -1
      this.stepsByIndex.clear()
      this.rejectedStepIndices.clear()
      this.rejectedGenericStepIndices.clear()
      this.stepStateReset = true
    }
    const readOffset = this.transcriptByteOffset
    if (st.size <= readOffset) {
      return
    }
    const toRead = st.size - readOffset
    const buf = Buffer.allocUnsafe(toRead)
    let bytesRead = 0
    try {
      const handle = await open(chosen, 'r')
      try {
        bytesRead = (await handle.read(buf, 0, toRead, readOffset)).bytesRead
      } finally {
        await handle.close()
      }
    } catch {
      return
    }
    const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (lastNewline === -1) {
      return
    }
    const chunk = buf.subarray(0, lastNewline + 1).toString('utf8')
    this.transcriptByteOffset = Math.max(this.transcriptByteOffset, readOffset + lastNewline + 1)
    for (const line of chunk.split('\n')) {
      if (!line.trim()) {
        continue
      }
      const linePosition = this.transcriptLineCursor
      this.transcriptLineCursor += 1
      try {
        const raw: unknown = JSON.parse(line)
        const parsed = transcriptStepSchema.safeParse(raw)
        if (!parsed.success) {
          if (typeof raw === 'object' && raw !== null) {
            const rejectedIdx =
              'step_index' in raw && typeof raw.step_index === 'number'
                ? raw.step_index
                : linePosition
            this.rejectedStepIndices.add(rejectedIdx)
            if (rejectedIdx > this.maxStepIndex) {
              this.maxStepIndex = rejectedIdx
            }
            if ('type' in raw && raw.type === 'GENERIC') {
              this.rejectedGenericStepIndices.add(rejectedIdx)
            }
          }
          continue
        }
        const step = parsed.data
        const idx = step.step_index ?? linePosition
        step.step_index = idx
        this.rejectedStepIndices.delete(idx)
        this.rejectedGenericStepIndices.delete(idx)
        this.stepsByIndex.set(idx, step)
        if (idx > this.maxStepIndex) {
          this.maxStepIndex = idx
        }
        if (step.type === 'PLANNER_RESPONSE' && Array.isArray(step.tool_calls)) {
          for (const call of step.tool_calls) {
            if (
              call.name === 'manage_task' &&
              call.args?.Action === 'kill' &&
              typeof call.args.TaskId === 'string'
            ) {
              this.killedTaskIds.add(call.args.TaskId)
            }
          }
        }
      } catch {
        /* Ignore partially written JSON lines. */
      }
    }
  }

  /** Parse newly arrived background-task completion JSON files under `<sysDir>/messages`. */
  private async refreshMessages(
    sysDir: string,
    onLauncherToolId: (toolCallId: string) => void
  ): Promise<void> {
    const msgDir = join(sysDir, 'messages')
    const files = await readdir(msgDir).catch(() => null)
    if (!files) {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'read.json' || this.parsedMessages.has(file)) {
        continue
      }
      const fullMsgPath = join(msgDir, file)
      try {
        const [st, text] = await Promise.all([stat(fullMsgPath), readFile(fullMsgPath, 'utf8')])
        const parsedJson = taskMessageFileSchema.safeParse(JSON.parse(text))
        if (!parsedJson.success) {
          this.parsedMessages.set(file, { content: '', mtimeMs: st.mtimeMs })
          continue
        }
        const raw = parsedJson.data
        const toolCallId = raw.sourceMetadata?.tool?.toolCall?.id
        const parsed: AntigravitySettledTaskMessage = {
          sender: raw.sender,
          stepIndex: raw.sourceMetadata?.tool?.stepIndex,
          toolCallId,
          content: raw.content ?? '',
          mtimeMs: st.mtimeMs
        }
        this.parsedMessages.set(file, parsed)
        if (toolCallId) {
          onLauncherToolId(toolCallId)
        }
        if (raw.sender) {
          this.settledTasks.set(raw.sender, parsed)
        }
      } catch {
        /* Retry on next poll if file is still being written. */
      }
    }
  }
}
