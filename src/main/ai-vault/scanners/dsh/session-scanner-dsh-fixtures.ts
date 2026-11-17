import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'

/** One checksummed frame per append batch, as dsh-session-persistence-jsonl writes it. */
function dshSessionFrame(rows: readonly object[]): Buffer {
  const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 }
  })
}

function dshSessionFile(sessionsDir: string, slug: string, sessionId: string): string {
  return join(sessionsDir, slug, sessionId, 'session.v4.jsonl.zstd')
}

/** A subagent log is a sibling file and must stay out of History. */
export async function writeDshSubagentFixture(sessionsDir: string): Promise<string> {
  const childFile = dshSessionFile(sessionsDir, '--tmp-dsh--', 'dsh-child')
  await mkdir(dirname(childFile), { recursive: true })
  await writeFile(
    childFile,
    dshSessionFrame([
      {
        type: 'session',
        version: 4,
        id: 'dsh-child',
        createdAt: 1780000000000,
        cwd: '/tmp/dsh',
        isSeeded: false,
        delegationDepth: 1,
        origin: 'subagent',
        parentSession: 'dsh-session'
      }
    ])
  )
  return childFile
}

export async function writeDshScannerFixture(sessionsDir: string): Promise<string> {
  const sessionFile = dshSessionFile(sessionsDir, '--tmp-dsh--', 'dsh-session')
  await mkdir(dirname(sessionFile), { recursive: true })
  await writeFile(
    sessionFile,
    Buffer.concat([
      dshSessionFrame([
        {
          type: 'session',
          version: 4,
          id: 'dsh-session',
          createdAt: 1780000000000,
          cwd: '/tmp/dsh',
          isSeeded: false,
          delegationDepth: 0,
          agentPreset: 'standard'
        }
      ]),
      dshSessionFrame([
        {
          type: 'user/message',
          seq: 0,
          time: 1780000001000,
          data: {
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'Dsh vault title' }]
          }
        },
        {
          type: 'request/context',
          seq: 1,
          time: 1780000001100,
          data: { provider: 'litellm', model: 'dsh-test-model', contextWindow: 1000 }
        }
      ]),
      dshSessionFrame([
        {
          type: 'session/title',
          seq: 2,
          time: 1780000001200,
          data: { title: 'Dsh vault ti', source: { kind: 'fallback' } }
        },
        {
          type: 'assistant/message',
          seq: 3,
          time: 1780000002000,
          data: {
            turn: 1,
            step: 1,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Dsh answer' }]
            },
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
          }
        },
        {
          type: 'session/title',
          seq: 4,
          time: 1780000002100,
          data: { title: 'Dsh vault title', source: { kind: 'provider' } }
        }
      ])
    ])
  )
  return sessionFile
}

/** Two format generations in one session directory, as a migration leaves them. */
export async function writeDshGenerationFixture(sessionsDir: string): Promise<string> {
  const generation = (version: number, title: string): Buffer =>
    dshSessionFrame([
      {
        type: 'session',
        version,
        id: 'dsh-gen',
        createdAt: 1780000000000,
        cwd: '/tmp/dsh',
        isSeeded: false,
        delegationDepth: 0
      },
      ...(title
        ? [
            {
              type: 'session/title',
              seq: 0,
              time: 1780000001000,
              data: { title, source: { kind: 'provider' } }
            }
          ]
        : [])
    ])
  const older = dshSessionFile(sessionsDir, '--tmp-dsh--', 'dsh-gen')
  await mkdir(dirname(older), { recursive: true })
  await writeFile(older, generation(4, 'Dsh generation 4'))
  const newer = older.replace('session.v4', 'session.v5')
  await writeFile(newer, generation(5, 'Dsh generation 5'))
  return newer
}

/** A pre-ordinary-fork session records `parentSession` without being a subagent. */
export async function writeDshForkFixture(sessionsDir: string): Promise<string> {
  const fork = dshSessionFile(sessionsDir, '--tmp-dsh--', 'dsh-fork')
  await mkdir(dirname(fork), { recursive: true })
  await writeFile(
    fork,
    dshSessionFrame([
      {
        type: 'session',
        version: 4,
        id: 'dsh-fork',
        createdAt: 1780000000000,
        cwd: '/tmp/dsh',
        isSeeded: true,
        delegationDepth: 0,
        parentSession: 'dsh-session'
      }
    ])
  )
  return fork
}
