import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isKiroSessionMetadataPath,
  kiroTranscriptPathForMetadata,
  parseKiroSessionContent,
  parseKiroSessionFile
} from './session-scanner-kiro-parser'

const SESSION_ID = '0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d'

const metadata = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: '/tmp/kiro',
    created_at: '2026-05-01T10:13:00.123456789Z',
    updated_at: '2026-05-01T10:13:05.000000000Z',
    title: 'Fix the login bug',
    session_state: { rts_model_state: { model_info: { model_id: 'claude-opus-5' } } },
    ...extra
  })

const prompt = JSON.stringify({
  version: 'v1',
  kind: 'Prompt',
  data: { content: [{ kind: 'text', data: 'Fix the login bug' }], meta: { timestamp: 1777630381 } }
})
const reply = JSON.stringify({
  version: 'v1',
  kind: 'AssistantMessage',
  data: { content: [{ kind: 'text', data: 'Fixed it.' }] }
})

const fileAt = (path: string) => ({ path, mtimeMs: 1, modifiedAt: new Date(1).toISOString() })

let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function writeSession(meta: string, transcript?: string): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'orca-kiro-sessions-'))
  const path = join(root, `${SESSION_ID}.json`)
  await writeFile(path, meta)
  if (transcript !== undefined) {
    await writeFile(kiroTranscriptPathForMetadata(path), transcript)
  }
  return path
}

describe('Kiro session parser', () => {
  it('matches only <uuid>.json metadata files', () => {
    expect(isKiroSessionMetadataPath(`/x/${SESSION_ID}.json`)).toBe(true)
    expect(isKiroSessionMetadataPath(`/x/${SESSION_ID}.jsonl`)).toBe(false)
    expect(isKiroSessionMetadataPath(`/x/${SESSION_ID}.lock`)).toBe(false)
    expect(isKiroSessionMetadataPath('/x/agent_config.json')).toBe(false)
  })

  it('reads title, cwd, model and turns from metadata plus transcript', async () => {
    const path = await writeSession(metadata(), `${prompt}\n${reply}\n`)
    const session = await parseKiroSessionFile(fileAt(path), 'linux')
    expect(session).toMatchObject({
      agent: 'kiro',
      sessionId: SESSION_ID,
      title: 'Fix the login bug',
      cwd: '/tmp/kiro',
      model: 'claude-opus-5',
      messageCount: 2
    })
    expect(session?.previewMessages.map((message) => message.text)).toEqual([
      'Fix the login bug',
      'Fixed it.'
    ])
  })

  it('keeps a complete final record that lacks a trailing newline', async () => {
    const path = await writeSession(metadata(), `${prompt}\n${reply}`)
    expect((await parseKiroSessionFile(fileAt(path), 'linux'))?.messageCount).toBe(2)
  })

  it('lists a session whose transcript has not been written yet', async () => {
    const path = await writeSession(metadata())
    const session = await parseKiroSessionFile(fileAt(path), 'linux')
    expect(session?.messageCount).toBe(0)
    expect(session?.title).toBe('Fix the login bug')
  })

  it('omits a subagent child session from the top-level list', async () => {
    const path = await writeSession(
      metadata({ parent_session_id: '1c6f2d3b-4e5a-4b6c-9d7e-8f9a0b1c2d3e' }),
      `${prompt}\n`
    )
    expect(await parseKiroSessionFile(fileAt(path), 'linux')).toBeNull()
  })

  it('resumes by the validated file name, not a mismatched metadata session_id', async () => {
    const path = await writeSession(metadata({ session_id: "x' && rm -rf ~" }))
    const session = await parseKiroSessionFile(fileAt(path), 'linux')
    expect(session?.sessionId).toBe(SESSION_ID)
    expect(session?.resumeCommand).toContain(`--resume-id '${SESSION_ID}'`)
  })

  it('parses streamed remote lines the same way', async () => {
    const session = await parseKiroSessionContent(
      fileAt(`/home/u/.kiro/sessions/cli/${SESSION_ID}.json`),
      metadata(),
      [prompt, reply],
      'linux'
    )
    expect(session?.messageCount).toBe(2)
    expect(session?.resumeCommand).toBe(
      `cd '/tmp/kiro' && kiro-cli chat --tui --resume-id '${SESSION_ID}'`
    )
  })
})
