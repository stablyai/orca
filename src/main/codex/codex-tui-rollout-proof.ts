import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { listCodexSessionJsonlFilesIncrementally } from './codex-session-file-listing'

const SESSION_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const STATUS_SESSION_RE = new RegExp(
  `\\b(?:Session|Thread)(?:\\s+ID)?\\s*:\\s*(${SESSION_ID_PATTERN})\\b`,
  'gi'
)
const ROLLOUT_READ_LIMIT = 64 * 1024
const STATUS_COMMAND_PASTE = '\u001b[200~/status\u001b[201~'
const KITTY_ENTER = '\u001b[13u'
const TAB = '\t'

export type CodexTuiProofOutput = {
  text: string
  lastOutputAt: number | null
}

export type CodexTuiRolloutProofOptions = {
  listFiles?: (sessionsRoot: string) => AsyncIterable<string>
  readSessionMetaId?: (filePath: string) => Promise<string | null>
}

export function parseCodexTuiStatusSessionId(output: string): string | null {
  let sessionId: string | null = null
  for (const match of stripAnsiEscapeSequences(output).matchAll(STATUS_SESSION_RE)) {
    sessionId = match[1] ?? null
  }
  return sessionId
}

export function codexTuiStatusSubmitInput(kittyKeyboardFlags: number): string {
  return kittyKeyboardFlags > 0 ? KITTY_ENTER : '\r'
}

export function codexTuiStatusProbeInput(kittyKeyboardFlags: number): {
  command: string
  submit: string
} {
  return {
    command: STATUS_COMMAND_PASTE,
    submit: codexTuiStatusSubmitInput(kittyKeyboardFlags)
  }
}

export async function resolvePinnedCodexRolloutProof(
  codexHome: string,
  threadId: string,
  options: CodexTuiRolloutProofOptions = {}
): Promise<string | null> {
  const sessionsRoot = join(codexHome, 'sessions')
  const listFiles =
    options.listFiles ??
    ((root: string) => listCodexSessionJsonlFilesIncrementally(root, { batchSize: 64, yieldMs: 0 }))
  const readSessionMetaId = options.readSessionMetaId ?? readCodexRolloutSessionMetaId
  const expectedThreadSegment = `-${threadId.toLowerCase()}`

  for await (const filePath of listFiles(sessionsRoot)) {
    const relativePath = relativePathInsideRoot(sessionsRoot, filePath)?.replace(/\\/g, '/')
    if (
      !relativePath ||
      !/^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(relativePath) ||
      !(() => {
        const lower = relativePath.toLowerCase()
        const marker = lower.lastIndexOf(expectedThreadSegment)
        if (marker === -1) {
          return false
        }
        const after = lower.slice(marker + expectedThreadSegment.length)
        return after === '.jsonl' || (after.startsWith('_') && after.endsWith('.jsonl'))
      })()
    ) {
      continue
    }
    if ((await readSessionMetaId(filePath)) === threadId) {
      return filePath
    }
  }
  return null
}

export async function proveCodexTuiRollout(input: {
  codexHome: string
  threadId: string
  kittyKeyboardFlags: number
  readOutput: () => CodexTuiProofOutput
  write: (data: string) => boolean
  timeoutMs?: number
  resolveRollout?: (codexHome: string, threadId: string) => Promise<string | null>
  delay?: (ms: number) => Promise<void>
}): Promise<{ transcriptPath: string }> {
  const resolveRollout = input.resolveRollout ?? resolvePinnedCodexRolloutProof
  const delay = input.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const proofDeadline = Date.now() + (input.timeoutMs ?? 15_000)
  let transcriptPath: string | null = null
  // Codex can rotate or finish flushing the rollout while the resumed TUI is
  // starting. Keep the proof retryable inside the same bounded deadline.
  while (!transcriptPath && Date.now() < proofDeadline) {
    transcriptPath = await resolveRollout(input.codexHome, input.threadId)
    if (!transcriptPath) {
      await delay(Math.min(100, Math.max(1, proofDeadline - Date.now())))
    }
  }
  if (!transcriptPath) {
    throw new Error('The agent terminal did not prove the expected Codex rollout.')
  }

  const baselineOutputAt = input.readOutput().lastOutputAt
  const probe = codexTuiStatusProbeInput(input.kittyKeyboardFlags)
  if (!input.write(probe.command)) {
    throw new Error('The agent terminal could not verify its Codex session.')
  }
  await delay(100)
  if (!input.write(probe.submit)) {
    throw new Error('The agent terminal could not verify its Codex session.')
  }

  const deadline = proofDeadline
  const retrySubmitAt = Date.now() + 750
  let retriedSubmit = false
  while (Date.now() < deadline) {
    const output = input.readOutput()
    if (
      !retriedSubmit &&
      Date.now() >= retrySubmitAt &&
      output.text.includes('/status') &&
      !parseCodexTuiStatusSessionId(output.text)
    ) {
      retriedSubmit = true
      // Newer Codex builds keep the slash-command popup open after a bracketed
      // paste. Tab commits the highlighted command as text; the following Enter
      // then dispatches it instead of merely selecting the popup row.
      if (!input.write(TAB)) {
        throw new Error('The agent terminal could not finish Codex session verification.')
      }
      await delay(100)
      if (!input.write(probe.submit)) {
        throw new Error('The agent terminal could not finish Codex session verification.')
      }
    }
    if (output.lastOutputAt !== baselineOutputAt) {
      const observedThreadId = parseCodexTuiStatusSessionId(output.text)
      if (observedThreadId && observedThreadId !== input.threadId) {
        throw new Error('The agent terminal resumed a different Codex session.')
      }
      if (observedThreadId === input.threadId) {
        if (!input.write('\u001b')) {
          throw new Error('The agent terminal could not finish Codex session verification.')
        }
        return { transcriptPath }
      }
    }
    await delay(100)
  }
  throw new Error('The agent terminal did not prove the expected Codex rollout.')
}

export async function resolveLiveCodexTuiRollout(input: {
  codexHome: string
  kittyKeyboardFlags: number
  readOutput: () => CodexTuiProofOutput
  write: (data: string) => boolean
  timeoutMs?: number
  resolveRollout?: (codexHome: string, threadId: string) => Promise<string | null>
  delay?: (ms: number) => Promise<void>
}): Promise<{ threadId: string; transcriptPath?: string }> {
  const baselineOutputAt = input.readOutput().lastOutputAt
  const probe = codexTuiStatusProbeInput(input.kittyKeyboardFlags)
  if (!input.write(probe.command)) {
    throw new Error('The agent terminal could not verify its Codex session.')
  }
  const delay = input.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  await delay(100)
  if (!input.write(probe.submit)) {
    throw new Error('The agent terminal could not verify its Codex session.')
  }

  const deadline = Date.now() + (input.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    const output = input.readOutput()
    if (output.lastOutputAt !== baselineOutputAt) {
      const threadId = parseCodexTuiStatusSessionId(output.text)
      if (threadId) {
        const resolveRollout = input.resolveRollout ?? resolvePinnedCodexRolloutProof
        let transcriptPath: string | null = null
        // Codex 0.148 allocates a session before it writes a rollout; give a just-written
        // file a short visibility window without rejecting a genuinely blank conversation.
        for (let attempt = 0; attempt < 5 && !transcriptPath; attempt += 1) {
          transcriptPath = await resolveRollout(input.codexHome, threadId)
          if (!transcriptPath && attempt < 4) {
            await delay(100)
          }
        }
        if (!input.write('\u001b')) {
          throw new Error('The agent terminal could not finish Codex session verification.')
        }
        return { threadId, ...(transcriptPath ? { transcriptPath } : {}) }
      }
    }
    await delay(100)
  }
  throw new Error('The agent terminal did not publish a resumable Codex conversation.')
}

async function readCodexRolloutSessionMetaId(filePath: string): Promise<string | null> {
  // A listed rollout may vanish before it is read — Codex prunes and rewrites
  // these files. One missing file must not abort the whole scan.
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(ROLLOUT_READ_LIMIT)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0]?.trim()
    if (!firstLine) {
      return null
    }
    const record = JSON.parse(firstLine) as {
      type?: unknown
      id?: unknown
      session_id?: unknown
      thread_id?: unknown
      payload?: { id?: unknown; session_id?: unknown; thread_id?: unknown }
    }
    if (record.type !== 'session_meta') {
      return null
    }
    const id =
      record.payload?.id ??
      record.payload?.session_id ??
      record.payload?.thread_id ??
      record.id ??
      record.session_id ??
      record.thread_id
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  } finally {
    await file.close()
  }
}
