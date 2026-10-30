import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseJunieSessionFile } from './session-scanner-junie-parser'
import { clearJunieSessionIndexCache } from './session-scanner-junie-paths'
import type { FileWithMtime } from './session-scanner-types'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
  clearJunieSessionIndexCache()
})

const SESSION_ID = 'session-260824-144458-r0y6'
const CREATED_AT_MS = Date.parse('2026-08-24T14:44:58.000Z')
const UPDATED_AT_MS = Date.parse('2026-08-24T15:40:55.000Z')

// Mirrors real events.jsonl lines: kotlinx polymorphic events keyed by `kind`
// (not `type`), each stamped with `timestampMs`.
const EVENT_LINES = [
  {
    kind: 'SessionA2uxEvent',
    event: {
      state: 'IN_PROGRESS',
      agentEvent: { kind: 'AuthorizationAvailabilityEvent', authorized: true }
    },
    timestampMs: CREATED_AT_MS + 1000
  },
  {
    kind: 'UserPromptEvent',
    requestId: 'prompt-260824-144543-k0oy',
    prompt: 'Resolve the merge conflicts in PR 675',
    presentablePrompt: 'Resolve the merge conflicts in PR 675',
    timestampMs: CREATED_AT_MS + 2000
  },
  { kind: 'TaskStartedEvent', timestampMs: CREATED_AT_MS + 2500 },
  {
    kind: 'UserPromptEvent',
    requestId: 'prompt-260824-153757-11kr',
    prompt: 'Now run the tests',
    timestampMs: UPDATED_AT_MS - 1000
  }
]

async function writeJunieSession(
  options: {
    eventLines?: readonly unknown[] | null
    indexLines?: readonly unknown[] | null
  } = {}
): Promise<{ file: FileWithMtime; sessionsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-junie-parser-'))
  tempDirs.push(root)
  const sessionsDir = join(root, 'sessions')
  const sessionDir = join(sessionsDir, SESSION_ID)
  await mkdir(sessionDir, { recursive: true })

  const indexLines =
    options.indexLines === undefined
      ? [
          {
            sessionId: SESSION_ID,
            createdAt: CREATED_AT_MS,
            updatedAt: UPDATED_AT_MS,
            projectDir: '/tmp/junie-proj',
            taskName: 'Merge conflict cleanup'
          }
        ]
      : options.indexLines
  if (indexLines) {
    await writeFile(
      join(sessionsDir, 'index.jsonl'),
      indexLines.map((line) => JSON.stringify(line)).join('\n')
    )
  }

  const eventsPath = join(sessionDir, 'events.jsonl')
  const eventLines = options.eventLines === undefined ? EVENT_LINES : options.eventLines
  if (eventLines) {
    await writeFile(eventsPath, eventLines.map((line) => JSON.stringify(line)).join('\n'))
  }

  const mtimeMs = Date.now()
  return {
    file: { path: eventsPath, mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() },
    sessionsDir
  }
}

describe('parseJunieSessionFile', () => {
  it('parses a session from events.jsonl plus the shared index', async () => {
    const { file } = await writeJunieSession()

    const session = await parseJunieSessionFile(file, 'darwin')

    expect(session?.agent).toBe('junie')
    expect(session?.sessionId).toBe(SESSION_ID)
    expect(session?.title).toBe('Merge conflict cleanup')
    expect(session?.cwd).toBe('/tmp/junie-proj')
    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages.map((message) => message.text)).toEqual([
      'Resolve the merge conflicts in PR 675',
      'Now run the tests'
    ])
    expect(session?.createdAt).toBe(new Date(CREATED_AT_MS).toISOString())
    expect(session?.updatedAt).toBe(new Date(UPDATED_AT_MS).toISOString())
  })

  it('builds a cwd-scoped resume command pinned to the session id', async () => {
    const { file } = await writeJunieSession()

    const session = await parseJunieSessionFile(file, 'darwin')

    expect(session?.resumeCommand).toBe(
      `cd '/tmp/junie-proj' && junie --resume --session-id '${SESSION_ID}'`
    )
  })

  it('falls back to the first user prompt when the index has no task name', async () => {
    const { file } = await writeJunieSession({
      indexLines: [
        {
          sessionId: SESSION_ID,
          createdAt: CREATED_AT_MS,
          updatedAt: UPDATED_AT_MS,
          projectDir: '/tmp/junie-proj',
          taskName: null
        }
      ]
    })

    const session = await parseJunieSessionFile(file, 'darwin')

    expect(session?.title).toBe('Resolve the merge conflicts in PR 675')
  })

  it('still lists a session whose index entry is missing', async () => {
    const { file } = await writeJunieSession({ indexLines: null })

    const session = await parseJunieSessionFile(file, 'darwin')

    expect(session?.sessionId).toBe(SESSION_ID)
    expect(session?.cwd).toBeNull()
    expect(session?.title).toBe('Resolve the merge conflicts in PR 675')
  })

  it('titles an index-less session by its distinctive id part', async () => {
    // Why: every Junie id starts with `session-`, so the shared agent+id-prefix
    // fallback would label every untitled session identically.
    const { file } = await writeJunieSession({
      indexLines: null,
      eventLines: [{ kind: 'SessionA2uxEvent', event: { state: 'IN_PROGRESS' } }]
    })

    const session = await parseJunieSessionFile(file, 'darwin')

    expect(session?.title).toBe('Junie 260824-144458-r0y6')
  })

  it('lists a metadata-only session with no transcript yet', async () => {
    const { file } = await writeJunieSession({ eventLines: null })

    const session = await parseJunieSessionFile(file, 'darwin')

    expect(session?.sessionId).toBe(SESSION_ID)
    expect(session?.title).toBe('Merge conflict cleanup')
    expect(session?.messageCount).toBe(0)
  })

  it('skips malformed transcript lines instead of dropping the session', async () => {
    const { file } = await writeJunieSession()
    await writeFile(file.path, `{not-json\n${JSON.stringify(EVENT_LINES[1])}`)

    const session = await parseJunieSessionFile(file, 'darwin')

    expect(session?.messageCount).toBe(1)
  })
})
