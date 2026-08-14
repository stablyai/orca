import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { listCodexSessionJsonlFilesIncrementally } from './codex-session-file-listing'

const SESSION_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const STATUS_SESSION_RE = new RegExp(`\\bSession(?: ID)?\\s*:\\s*(${SESSION_ID_PATTERN})\\b`, 'gi')
const ROLLOUT_READ_LIMIT = 64 * 1024
const STATUS_COMMAND_PASTE = '\u001b[200~/status\u001b[201~'
const KITTY_ENTER = '\u001b[13u'

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
  const expectedSuffix = `-${threadId}.jsonl`.toLowerCase()

  for await (const filePath of listFiles(sessionsRoot)) {
    const relativePath = relativePathInsideRoot(sessionsRoot, filePath)?.replace(/\\/g, '/')
    if (
      !relativePath ||
      !/^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(relativePath) ||
      !relativePath.toLowerCase().endsWith(expectedSuffix)
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
  const transcriptPath = await resolveRollout(input.codexHome, input.threadId)
  if (!transcriptPath) {
    throw new Error('The agent terminal did not prove the expected Codex rollout.')
  }

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

async function readCodexRolloutSessionMetaId(filePath: string): Promise<string | null> {
  const file = await open(filePath, 'r')
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
      payload?: { id?: unknown }
    }
    if (record.type !== 'session_meta') {
      return null
    }
    const id = record.payload?.id ?? record.id
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  } finally {
    await file.close()
  }
}
