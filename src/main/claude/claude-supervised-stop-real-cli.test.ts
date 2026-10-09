import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { SUPERVISED_GRACEFUL_EXIT_MS } from './claude-child-exit-proof-ladder'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'
import { claudeStructuredPermissionOptions } from './claude-structured-permission-mode'

// Opt-in only: spends a real (haiku) turn per case. Run it in an isolated HOME with
// ORCA_REAL_CLAUDE_BIN set, and ORCA_REAL_CLAUDE_SETTINGS when auth lives in a settings file.
const CLAUDE_BIN = process.env.ORCA_REAL_CLAUDE_BIN ?? ''
const enabled =
  process.env.ORCA_REAL_CLAUDE_SUPERVISED_STOP === '1' &&
  process.platform !== 'win32' &&
  CLAUDE_BIN.length > 0
const FRAMES_OUT = process.env.ORCA_REAL_CLAUDE_FRAMES_OUT
const TOOL_MARKER = 'orca_supervised_stop_probe'
const TOOL_PROMPT = `Use the Bash tool to run exactly this command, with no timeout argument, and nothing else: python3 -c "import time; time.sleep(120)  # ${TOOL_MARKER}"`

type Frame = { at: number; message: Record<string, unknown> }
type Row = { pid: number; ppid: number; command: string }

const recordedPids = new Set<number>()
const tempDirs: string[] = []
const connections: ClaudeStreamJsonConnection[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function processTable(): Promise<Row[]> {
  const result = await runProcess({ program: 'ps', args: ['-axo', 'pid=,ppid=,command='] })
  return result.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
}

async function descendantsOf(rootPid: number): Promise<Row[]> {
  const rows = await processTable()
  const found: Row[] = []
  const frontier = [rootPid]
  while (frontier.length > 0) {
    const parent = frontier.pop()
    for (const row of rows.filter((candidate) => candidate.ppid === parent)) {
      found.push(row)
      frontier.push(row.pid)
    }
  }
  return found
}

async function until<T>(read: () => Promise<T | null> | T | null, what: string, ms = 90_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== null) {
      return value
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function open(sessionId: string, cwd: string, resume: boolean, frames: Frame[]) {
  const settings = process.env.ORCA_REAL_CLAUDE_SETTINGS
  const permission = claudeStructuredPermissionOptions('bypass')
  const connection = await openClaudeStreamJsonConnection(
    {
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      options: {
        ...CLAUDE_STRUCTURED_BASE_OPTIONS,
        model: 'haiku',
        extraArgs: {
          ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs,
          ...permission.extraArgs,
          ...(settings ? { settings } : {})
        },
        ...(resume ? { resume: sessionId } : { sessionId })
      },
      cwd
    },
    { onMessage: (message) => frames.push({ at: Date.now(), message }) }
  )
  connections.push(connection)
  recordedPids.add(connection.pid!)
  return connection
}

function userMessage(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: ''
  }
}

async function transcriptLines(sessionId: string): Promise<string> {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  const path = await until(
    () =>
      resolveSessionFilePath('claude', sessionId, {
        claudeProjectsDir: join(configDir, 'projects')
      }),
    'the transcript',
    15_000
  )
  return readFileSync(path, 'utf8')
}

function expectLineAtomic(contents: string): void {
  expect(contents.length).toBeGreaterThan(0)
  expect(contents.endsWith('\n')).toBe(true)
  for (const line of contents.split('\n').filter((entry) => entry.trim())) {
    expect(() => JSON.parse(line)).not.toThrow()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function summarize(frames: Frame[], since: number): string[] {
  return frames
    .filter((frame) => frame.at >= since)
    .map(({ at, message }) => {
      const inner = isRecord(message.message) ? message.message.content : undefined
      const blocks = (Array.isArray(inner) ? inner : [])
        .filter(isRecord)
        .map((block) =>
          block.type === 'tool_result'
            ? `tool_result(is_error=${String(block.is_error)}:${JSON.stringify(block.content).slice(0, 80)})`
            : String(block.type)
        )
      return `+${at - since}ms ${String(message.type)}/${String(message.subtype ?? '')}${
        message.type === 'result' ? `(is_error=${String(message.is_error)})` : ''
      } ${blocks.join(',')}`.trim()
    })
}

async function resumeAndAsk(sessionId: string, cwd: string): Promise<void> {
  const frames: Frame[] = []
  const resumed = await open(sessionId, cwd, true, frames)
  await resumed.send(userMessage('In one short line: what command did I ask you to run?'))
  const result = await until(
    () => frames.find((frame) => frame.message.type === 'result')?.message ?? null,
    'the resumed turn result'
  )
  expect(result.subtype).toBe('success')
  await expect(resumed.close()).resolves.toBe(true)
}

type StopCase = 'close mid-tool' | 'SIGTERM to the supervisor mid-tool' | 'close while idle'

afterEach(async () => {
  for (const pid of recordedPids) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  recordedPids.clear()
  connections.splice(0)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.runIf(enabled)('real Claude stopped through the POSIX supervisor', () => {
  it.each<StopCase>(['close mid-tool', 'SIGTERM to the supervisor mid-tool', 'close while idle'])(
    '%s: stops Claude and its tool, keeps the transcript line-atomic, and resumes',
    async (stopCase) => {
      const cwd = mkdtempSync(join(tmpdir(), 'orca-real-claude-stop-'))
      tempDirs.push(cwd)
      const sessionId = randomUUID()
      const frames: Frame[] = []
      const connection = await open(sessionId, cwd, false, frames)
      const supervisor = connection.pid!
      const midTool = stopCase !== 'close while idle'
      await connection.send(userMessage(midTool ? TOOL_PROMPT : 'Reply with the single word: ok'))
      const descendants = midTool
        ? await until(async () => {
            const rows = await descendantsOf(supervisor)
            return rows.some((row) => row.command.includes(TOOL_MARKER)) ? rows : null
          }, 'the Bash tool').catch((error: unknown) => {
            console.log('[no tool] frames so far:', summarize(frames, 0))
            throw error
          })
        : await until(
            async () =>
              frames.some((frame) => frame.message.type === 'result')
                ? await descendantsOf(supervisor)
                : null,
            'the idle turn'
          )
      for (const row of descendants) {
        recordedPids.add(row.pid)
      }

      const signalledAt = Date.now()
      if (stopCase === 'SIGTERM to the supervisor mid-tool') {
        process.kill(supervisor, 'SIGTERM')
      } else {
        await expect(connection.close()).resolves.toBe(true)
      }
      const gone = await until(
        () => ([supervisor, ...descendants.map((row) => row.pid)].some(alive) ? null : true),
        'the supervisor, Claude and its tools to exit',
        SUPERVISED_GRACEFUL_EXIT_MS + 2_000
      )
      const stoppedMs = Date.now() - signalledAt
      const after = summarize(frames, signalledAt)
      console.log(`[${stopCase}] stopped in ${stoppedMs} ms; frames after the stop:`, after)
      if (FRAMES_OUT) {
        writeFileSync(
          `${FRAMES_OUT}.${stopCase.replaceAll(' ', '-')}.json`,
          JSON.stringify({ stoppedMs, after }, null, 2)
        )
      }
      expect(gone).toBe(true)

      expectLineAtomic(await transcriptLines(sessionId))
      await resumeAndAsk(sessionId, cwd)
      expectLineAtomic(await transcriptLines(sessionId))
    },
    180_000
  )
})
