import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { parseDshSessionLines } from './session-scanner-dsh-parser'
import {
  DSH_FIXTURE_SESSION_ID,
  DSH_FIXTURE_SUBAGENT_SESSION_ID,
  writeDshScannerFixture,
  writeDshUnlistedSessionFixtures
} from './session-scanner-dsh-fixtures'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import type { TranscriptMessage } from './session-transcript-consumers'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function scanDshFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-dsh-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const sessionFile = await writeDshScannerFixture(roots.dshSessionsDir)
  await writeDshUnlistedSessionFixtures(roots.dshSessionsDir)
  return { roots, sessionFile }
}

describe('scanAiVaultSessions dsh', () => {
  it('lists a multi-frame zstd session with title, model, tokens, and resume command', async () => {
    const { roots, sessionFile } = await scanDshFixture()

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 20
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual([DSH_FIXTURE_SESSION_ID])
    const session = result.sessions[0]
    expect(session.agent).toBe('dsh')
    expect(session.title).toBe('DSH vault prompt')
    expect(session.cwd).toBe('/tmp/dsh')
    expect(session.model).toBe('deepseek-test')
    expect(session.totalTokens).toBe(20)
    // The injected agent-instructions turn and the tool-call-only step are not counted.
    expect(session.messageCount).toBe(2)
    expect(session.previewMessages.map((message) => message.text)).toEqual([
      'DSH vault prompt',
      'DSH answer'
    ])
    expect(session.filePath).toBe(sessionFile)
    expect(session.resumeCommand).toBe(
      `cd '/tmp/dsh' && dsh-tui --backend=dsh --resume '${DSH_FIXTURE_SESSION_ID}'`
    )
    expect(result.sessions.some((row) => row.sessionId === DSH_FIXTURE_SUBAGENT_SESSION_ID)).toBe(
      false
    )
  })

  it('keeps one row per session dir, preferring the newest file generation', async () => {
    const { roots, sessionFile } = await scanDshFixture()
    const olderGeneration = join(dirname(sessionFile), 'session.v3.jsonl')
    await writeFile(
      olderGeneration,
      `${JSON.stringify({ type: 'session', version: 3, id: DSH_FIXTURE_SESSION_ID, createdAt: 1 })}\n`
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 20
    })

    expect(result.sessions.map((session) => session.filePath)).toEqual([sessionFile])
  })

  it('reports an undecodable file as a scan issue instead of failing the scan', async () => {
    const { roots, sessionFile } = await scanDshFixture()
    await writeFile(sessionFile, 'not zstd')

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 20
    })

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([expect.objectContaining({ agent: 'dsh', path: sessionFile })])
  })

  it('lists an uncompressed session written with compression off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-dsh-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionDir = join(roots.dshSessionsDir, '--tmp-dsh--', 'plain')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl'), `${sampleCaptureLines().join('\n')}\n`)

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => [session.sessionId, session.title])).toEqual([
      ['capture', 'Capture this prompt']
    ])
  })

  it('prefers a chosen title over the fallback stub', () => {
    const lines = [
      {
        type: 'session',
        version: 4,
        id: 'titled',
        createdAt: 1780000000000,
        cwd: '/tmp/dsh'
      },
      {
        type: 'session/title',
        seq: 1,
        time: 1780000001000,
        data: { title: 'Picked title' }
      },
      {
        type: 'session/title',
        seq: 2,
        time: 1780000002000,
        data: { title: 'stub', source: { kind: 'fallback' } }
      }
    ].map((record) => JSON.stringify(record))

    const session = parseDshSessionLines(
      {
        path: '/tmp/dsh-sessions/p/titled/session.v4.jsonl',
        mtimeMs: 1,
        modifiedAt: ''
      },
      lines,
      'darwin'
    )

    expect(session?.title).toBe('Picked title')
  })

  it('publishes typed user turns and assistant replies to transcript consumers', () => {
    const messages: TranscriptMessage[] = []
    const lines = sampleCaptureLines()

    parseDshSessionLines(
      {
        path: '/tmp/dsh-sessions/p/capture/session.v4.jsonl',
        mtimeMs: 1,
        modifiedAt: ''
      },
      lines,
      'darwin',
      { active: true, push: (message) => messages.push(message) }
    )

    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'Capture this prompt'],
      ['assistant', 'Captured reply']
    ])
  })
})

function sampleCaptureLines(): string[] {
  return [
    { type: 'session', version: 4, id: 'capture', createdAt: 1780000000000 },
    {
      type: 'user/message',
      seq: 1,
      time: 1780000001000,
      data: {
        content: [{ type: 'text', text: 'Capture this prompt' }],
        source: { kind: 'user' }
      }
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1780000002000,
      data: {
        message: { content: [{ type: 'text', text: 'Captured reply' }] }
      }
    }
  ].map((record) => JSON.stringify(record))
}
