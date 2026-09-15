import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'
import { parseAgentSessionFile } from './session-scanner-agent-parser'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('ZeroClaw session scanner & parser', () => {
  it('discovers and parses ZeroClaw sessions from both top-level and agent subdirectories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-zeroclaw-vault-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)

    const topLevelSessionsDir = join(roots.zeroclawStateDir, 'sessions')
    const agentSessionsDir = join(roots.zeroclawStateDir, 'agents', 'lead-agent', 'sessions')
    await mkdir(topLevelSessionsDir, { recursive: true })
    await mkdir(agentSessionsDir, { recursive: true })

    await writeFile(
      join(topLevelSessionsDir, 'zc-session-1.jsonl'),
      jsonLines([
        {
          type: 'session',
          id: 'zc-session-1',
          timestamp: '2026-05-01T12:00:00.000Z',
          cwd: '/repo/zeroclaw-app'
        },
        {
          type: 'model_change',
          model: 'claude-sonnet-4-5',
          timestamp: '2026-05-01T12:00:01.000Z'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T12:00:02.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Build a high-performance backend' }]
          }
        },
        {
          type: 'message',
          timestamp: '2026-05-01T12:00:05.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'Starting build in Rust...' }],
            usage: {
              input_tokens: 150,
              output_tokens: 80
            }
          }
        }
      ])
    )

    await writeFile(
      join(agentSessionsDir, 'zc-session-2.jsonl'),
      jsonLines([
        {
          type: 'session',
          id: 'zc-session-2',
          timestamp: '2026-05-01T13:00:00.000Z',
          cwd: '/repo/zeroclaw-sub'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T13:00:01.000Z',
          message: {
            role: 'user',
            content: 'Optimize agent memory footprint'
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 10
    })

    expect(result.issues).toEqual([])
    const zcSessions = result.sessions.filter((s) => s.agent === 'zeroclaw')
    expect(zcSessions).toHaveLength(2)

    const session1 = zcSessions.find((s) => s.sessionId === 'zc-session-1')
    expect(session1).toBeDefined()
    expect(session1?.title).toBe('Build a high-performance backend')
    expect(session1?.model).toBe('claude-sonnet-4-5')
    expect(session1?.totalTokens).toBe(230)
    expect(session1?.cwd).toBe('/repo/zeroclaw-app')
    expect(session1?.resumeCommand).toBe(
      "cd '/repo/zeroclaw-app' && zeroclaw --session 'zc-session-1'"
    )

    const session2 = zcSessions.find((s) => s.sessionId === 'zc-session-2')
    expect(session2).toBeDefined()
    expect(session2?.title).toBe('Optimize agent memory footprint')
    expect(session2?.cwd).toBe('/repo/zeroclaw-sub')
    expect(session2?.resumeCommand).toBe(
      "cd '/repo/zeroclaw-sub' && zeroclaw --session 'zc-session-2'"
    )
  })

  it('parses directly via parseAgentSessionFile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-zc-direct-'))
    tempRoots.push(root)
    const filePath = join(root, 'zc.jsonl')

    await writeFile(
      filePath,
      jsonLines([
        {
          type: 'session',
          id: 'zc-direct-1',
          timestamp: '2026-05-01T14:00:00.000Z',
          cwd: '/repo/test'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T14:00:01.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Direct parse test' }]
          }
        }
      ])
    )

    const session = await parseAgentSessionFile(
      {
        agent: 'zeroclaw',
        file: { path: filePath, mtimeMs: Date.now(), modifiedAt: new Date().toISOString() },
        codexHome: null
      },
      'darwin'
    )

    expect(session).not.toBeNull()
    expect(session?.agent).toBe('zeroclaw')
    expect(session?.sessionId).toBe('zc-direct-1')
    expect(session?.title).toBe('Direct parse test')
  })
})
