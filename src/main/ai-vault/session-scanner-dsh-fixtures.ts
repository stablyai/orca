import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

export const DSH_FIXTURE_SESSION_ID = '9c899823-da81-419a-a003-6c8bc583df20'
export const DSH_FIXTURE_SUBAGENT_SESSION_ID = '5b8c54ae-5110-4bdc-8e6f-69218b910d2a'
const DSH_FIXTURE_CWD = '/tmp/dsh'
const DSH_FIXTURE_PROJECT_DIR = '--tmp-dsh--'
const DSH_FIXTURE_CREATED_AT_MS = 1780000000000

function dshEvent(seq: number, type: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({ type, seq, time: DSH_FIXTURE_CREATED_AT_MS + seq * 1000, data })}\n`
}

/** The way DSH writes a session: one independent zstd frame per appended batch. */
function dshZstdSessionBytes(batches: readonly string[]): Buffer {
  return Buffer.concat(batches.map((batch) => zstdCompressSync(Buffer.from(batch))))
}

function dshHeader(id: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: 'session',
    version: 4,
    id,
    createdAt: DSH_FIXTURE_CREATED_AT_MS,
    cwd: DSH_FIXTURE_CWD,
    isSeeded: false,
    delegationDepth: 0,
    ...extra
  })}\n`
}

function dshUserMessage(seq: number, text: string, sourceKind: string): string {
  return dshEvent(seq, 'user/message', {
    content: [{ type: 'text', text }],
    source: { kind: sourceKind },
    role: 'user'
  })
}

async function writeDshSessionFile(
  sessionsDir: string,
  sessionId: string,
  batches: readonly string[]
): Promise<string> {
  const sessionDir = join(sessionsDir, DSH_FIXTURE_PROJECT_DIR, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.lock'), '')
  const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd')
  await writeFile(sessionFile, dshZstdSessionBytes(batches))
  return sessionFile
}

/**
 * A top-level DSH session as `<root>/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd`
 * (verified against dsh 0.14).
 * @returns The session's file path.
 */
export async function writeDshScannerFixture(sessionsDir: string): Promise<string> {
  const sessionFile = await writeDshSessionFile(sessionsDir, DSH_FIXTURE_SESSION_ID, [
    dshHeader(DSH_FIXTURE_SESSION_ID),
    dshUserMessage(1, 'DSH vault prompt', 'user') +
      dshUserMessage(2, '<system-reminder>instructions</system-reminder>', 'agent-instructions') +
      dshEvent(3, 'request/header', {
        header: { config: { provider: 'litellm', model: 'deepseek-test' } }
      }) +
      dshEvent(4, 'session/title', {
        title: 'DSH vault',
        source: { kind: 'fallback' }
      }),
    dshEvent(5, 'assistant/message', {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'DSH answer' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }
        ]
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    }) +
      dshEvent(6, 'assistant/message', {
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call-2' }]
        },
        usage: { totalTokens: 5 }
      })
  ])
  return sessionFile
}

/** Sessions the vault must not list: a subagent child and a dir holding only `session.lock`. */
export async function writeDshUnlistedSessionFixtures(sessionsDir: string): Promise<void> {
  await writeDshSessionFile(sessionsDir, DSH_FIXTURE_SUBAGENT_SESSION_ID, [
    dshHeader(DSH_FIXTURE_SUBAGENT_SESSION_ID, {
      parentSession: DSH_FIXTURE_SESSION_ID,
      origin: 'subagent',
      delegationDepth: 1
    }),
    dshUserMessage(1, 'Subagent task', 'user')
  ])
  const lockOnlyDir = join(sessionsDir, DSH_FIXTURE_PROJECT_DIR, 'lock-only-session')
  await mkdir(lockOnlyDir, { recursive: true })
  await writeFile(join(lockOnlyDir, 'session.lock'), '')
}
