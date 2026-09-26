import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, it, expect } from 'vitest'
import { createRelayAiVaultFilesystemProvider } from '../../relay/ai-vault-service-filesystem'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

const platform = getRemoteHostPlatform(
  process.platform === 'win32'
    ? 'win32-x64'
    : process.platform === 'darwin'
      ? 'darwin-arm64'
      : 'linux-x64'
)
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
const filler = jsonl([{ type: 'irrelevant_event', payload: 'x'.repeat(1024) }]).repeat(11000)

describe('large remote history through real relay filesystem', () => {
  it('reports an oversized record without losing healthy sessions or publishing a partial session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-history-record-limit-'))
    try {
      const directory = join(home, '.codex', 'sessions')
      await mkdir(directory, { recursive: true })
      const metadata = (id: string) =>
        jsonl([{ type: 'session_meta', payload: { id, cwd: '/repo' } }])
      const badPath = join(directory, 'bad.jsonl')
      await writeFile(badPath, metadata('bad') + 'x'.repeat(11 * 1024 * 1024))
      await writeFile(join(directory, 'good.jsonl'), metadata('good'))
      const result = await scanRemoteAiVaultSessions({
        provider: createRelayAiVaultFilesystemProvider(),
        executionHostId: 'ssh:record-limit',
        remoteHome: home,
        hostPlatform: platform,
        unlimited: true
      })
      expect(result.sessions.map((session) => session.sessionId)).toEqual(['good'])
      expect(result.issues).toEqual([
        expect.objectContaining({
          path: badPath.replace(/\\/g, '/'),
          message: 'Session transcript record exceeds 10485760 byte limit'
        })
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('lists a large Codex rollout with middle messages and usage intact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-history-17744-'))
    try {
      const path = join(home, '.codex', 'sessions', 'large.jsonl')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        jsonl([
          {
            type: 'session_meta',
            timestamp: '2026-09-13T01:00:00Z',
            payload: { id: 'large', cwd: '/repo' }
          },
          {
            type: 'response_item',
            timestamp: '2026-09-13T01:00:01Z',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Keep my history' }]
            }
          }
        ]) +
          filler.slice(0, filler.length / 2) +
          jsonl([
            {
              type: 'response_item',
              timestamp: '2026-09-13T01:02:00Z',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Middle answer' }]
              }
            },
            {
              type: 'event_msg',
              timestamp: '2026-09-13T01:03:00Z',
              payload: {
                type: 'token_count',
                info: {
                  total_token_usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 }
                }
              }
            }
          ]) +
          filler.slice(filler.length / 2)
      )
      const result = await scanRemoteAiVaultSessions({
        provider: createRelayAiVaultFilesystemProvider(),
        executionHostId: 'ssh:synthetic-17744',
        remoteHome: home,
        hostPlatform: platform,
        unlimited: true
      })
      expect(result.issues).toEqual([])
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]).toMatchObject({
        sessionId: 'large',
        messageCount: 2,
        totalTokens: 168,
        title: 'Keep my history'
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each(['hermes', 'devin', 'gemini', 'cline'] as const)(
    'lists large %s documents with every message counted',
    async (agent) => {
      const home = await mkdtemp(join(tmpdir(), 'orca-history-17744-document-'))
      try {
        const messages = Array.from({ length: 11000 }, () => ({
          role: 'assistant',
          content: 'x'.repeat(1024)
        }))
        messages.splice(5000, 0, { role: 'user', content: 'A middle user turn' })
        let path: string, record: unknown
        if (agent === 'hermes') {
          path = join(home, '.hermes', 'sessions', 'large.json')
          record = { session_id: 'large', cwd: '/repo', model: 'test-model', messages }
        } else if (agent === 'devin') {
          path =
            platform.os === 'win32'
              ? join(home, 'AppData', 'Roaming', 'devin', 'cli', 'transcripts', 'large.json')
              : join(home, '.local', 'share', 'devin', 'cli', 'transcripts', 'large.json')
          record = {
            session_id: 'large',
            working_directory: '/repo',
            steps: messages.map((message) => ({
              ...message,
              metadata: {
                is_user_input: message.role === 'user',
                metrics: { input_tokens: 2, output_tokens: 1 }
              }
            }))
          }
        } else if (agent === 'gemini') {
          path = join(home, '.gemini', 'tmp', 'large.json')
          record = {
            sessionId: 'large',
            messages: messages.map((message) => ({
              type: message.role === 'assistant' ? 'gemini' : 'user',
              content: message.content
            }))
          }
        } else {
          path = join(home, '.cline', 'data', 'sessions', 'large', 'large.json')
          record = { session_id: 'large', cwd: '/repo' }
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path.replace('.json', '.messages.json'), JSON.stringify({ messages }))
        }
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify(record))
        const result = await scanRemoteAiVaultSessions({
          provider: createRelayAiVaultFilesystemProvider(),
          executionHostId: `ssh:large-${agent}`,
          remoteHome: home,
          hostPlatform: platform,
          unlimited: true
        })
        expect(result.issues).toEqual([])
        expect(result.sessions).toHaveLength(1)
        expect(result.sessions[0]).toMatchObject({ agent, sessionId: 'large', messageCount: 11001 })
        if (agent === 'devin') {
          expect(result.sessions[0].totalTokens).toBe(33003)
        }
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )
  it('keeps normal-size reads on their existing path and supports providers without streaming', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-history-legacy-'))
    try {
      const directory = join(home, '.codex', 'sessions')
      await mkdir(directory, { recursive: true })
      const content = jsonl([{ type: 'session_meta', payload: { id: 'small', cwd: '/repo' } }])
      await writeFile(join(directory, 'small.jsonl'), content)
      const provider = createRelayAiVaultFilesystemProvider()
      provider.readTranscriptBytes = () => {
        throw new Error('Small file must keep its existing read path')
      }
      const small = await scanRemoteAiVaultSessions({
        provider,
        executionHostId: 'ssh:small-original',
        remoteHome: home,
        hostPlatform: platform,
        unlimited: true
      })
      expect(small.issues).toEqual([])
      expect(small.sessions.map((session) => session.sessionId)).toEqual(['small'])
      await writeFile(join(directory, 'large.jsonl'), content + filler)
      const legacy = { readDir: provider.readDir, readFile: provider.readFile, stat: provider.stat }
      const fallback = await scanRemoteAiVaultSessions({
        provider: legacy,
        executionHostId: 'ssh:legacy-original',
        remoteHome: home,
        hostPlatform: platform,
        unlimited: true
      })
      expect(fallback.sessions.map((session) => session.sessionId)).toEqual(['small'])
      expect(
        fallback.issues.some(
          (issue) => issue.path.endsWith('large.jsonl') && issue.message.includes('10MB limit')
        )
      ).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
