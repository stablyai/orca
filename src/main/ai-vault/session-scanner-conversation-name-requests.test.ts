import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildConversationNamePrompt } from '../../shared/conversation-name-generation'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function turn(sessionId: string, at: string, role: 'user' | 'assistant', content: string) {
  return {
    type: role,
    sessionId,
    timestamp: at,
    cwd: '/tmp/worktree',
    ...(role === 'user' ? { entrypoint: 'sdk-cli' } : {}),
    message: { role, content }
  }
}

// #29973: naming a chat runs a one-shot `claude -p` in the chat's folder, and the CLI saves that
// run next to the chat. Listed, it read as the chat, and opening it resumed the naming request.
describe('scanAiVaultSessions chat-naming requests', () => {
  it('lists the chat but not the request Orca ran to name it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-name-request-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, '-tmp-worktree')
    const request = 'Refactor the codebase into modules'
    await writeJsonlFile(join(projectDir, 'chat.jsonl'), [
      turn('chat', '2026-10-17T03:13:49.000Z', 'user', request),
      turn('chat', '2026-10-17T03:13:55.000Z', 'assistant', 'Starting on the refactor.')
    ])
    await writeJsonlFile(join(projectDir, 'title.jsonl'), [
      turn(
        'title',
        '2026-10-17T03:13:51.000Z',
        'user',
        buildConversationNamePrompt({ firstPrompt: request })
      ),
      turn('title', '2026-10-17T03:13:52.000Z', 'assistant', 'Refactor codebase into modules')
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['chat'])
  })

  it('keeps a real conversation that only quotes the naming prompt later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-name-request-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, '-tmp-worktree')
    await writeJsonlFile(join(projectDir, 'chat.jsonl'), [
      turn('chat', '2026-10-17T03:13:49.000Z', 'user', 'Why are my chats named oddly?'),
      turn('chat', '2026-10-17T03:13:50.000Z', 'assistant', 'Let me look.'),
      turn(
        'chat',
        '2026-10-17T03:13:51.000Z',
        'user',
        buildConversationNamePrompt({ firstPrompt: 'x' })
      )
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux' })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['chat'])
  })

  it('keeps a naming request someone opened and kept chatting in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-name-request-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, '-tmp-worktree')
    await writeJsonlFile(join(projectDir, 'continued.jsonl'), [
      turn(
        'continued',
        '2026-10-17T03:13:51.000Z',
        'user',
        buildConversationNamePrompt({ firstPrompt: 'x' })
      ),
      turn('continued', '2026-10-17T03:13:52.000Z', 'assistant', 'A title'),
      turn('continued', '2026-10-17T03:20:00.000Z', 'user', 'Now actually help me with x'),
      turn('continued', '2026-10-17T03:20:05.000Z', 'assistant', 'Sure.')
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'linux' })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['continued'])
  })
})
