import { runProcess } from '@orca/process-host'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import {
  isolatedScanRoots,
  writeAntigravityTranscript
} from '../../scanner-fixtures/session-scanner-test-fixtures'
import {
  antigravitySessionOrigin,
  antigravityTranscriptReferencePrompt
} from '../../../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { quoteStartupArg } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { quoteCmdDoubleQuoted } from '../../../../shared/shell/launch/shell-argument-quoting'
import './session-scanner-antigravity-history'
import './session-scanner-antigravity-metadata'

const temporaryDirectories: string[] = []
const conversationId = 'same-conversation-id'
const origins = ['antigravity-cli', 'antigravity-ide', 'antigravity'] as const
function records(prompt = 'Continue this verified example') {
  return [
    {
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-02T01:00:00Z',
      content: `<USER_REQUEST>${prompt}</USER_REQUEST>`
    }
  ]
}
async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-agy-ide-'))
  temporaryDirectories.push(home)
  return home
}
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((home) => rm(home, { recursive: true, force: true }))
  )
})

describe('Antigravity IDE history discovery', () => {
  it('requires client opt-in and keeps equal IDs in separate origins while selecting the full transcript', async () => {
    const home = await temporaryHome()
    for (const origin of origins) {
      const path = await writeAntigravityTranscript(
        join(home, '.gemini', origin, 'brain'),
        conversationId,
        records(origin)
      )
      await writeFile(
        join(dirname(path), 'transcript_full.jsonl'),
        `${jsonLines(records(origin))}\n`
      )
      await writeFile(
        join(dirname(path), 'artifact.jsonl'),
        `${jsonLines(records('Not history'))}\n`
      )
    }
    const options = {
      ...isolatedScanRoots(home),
      antigravityBrainDir: join(home, '.gemini', 'antigravity-cli', 'brain'),
      antigravityAppHome: home
    }
    const legacy = await scanAiVaultSessions(options)
    expect(legacy.sessions).toHaveLength(1)
    expect(antigravitySessionOrigin(legacy.sessions[0]!.filePath)).toBe('antigravity-cli')
    const result = await scanAiVaultSessions({ ...options, includeAntigravityIdeSessions: true })
    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(3)
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(3)
    for (const session of result.sessions) {
      expect(session.filePath).toContain('transcript_full.jsonl')
      if (antigravitySessionOrigin(session.filePath) === 'antigravity-cli') {
        expect(session.resumeCommand).toContain('--conversation')
      } else {
        expect(session.resumeCommand).toContain('--prompt-interactive')
        expect(session.resumeCommand).not.toContain('--conversation')
        const expectedPrompt = antigravityTranscriptReferencePrompt(session.filePath)
        const quotedPrompt =
          process.platform === 'win32'
            ? quoteCmdDoubleQuoted(expectedPrompt)
            : quoteStartupArg(expectedPrompt, 'posix')
        expect(session.resumeCommand).toContain(quotedPrompt)
      }
    }
  })

  it('joins bounded metadata by exact conversation ID within each origin and refuses conflicting workspaces', async () => {
    const home = await temporaryHome()
    for (const origin of origins) {
      const brain = join(home, '.gemini', origin, 'brain')
      await writeAntigravityTranscript(brain, conversationId, records('Same title across origins'))
      const cache = join(dirname(brain), 'cache')
      await mkdir(cache, { recursive: true })
      await writeFile(
        join(cache, 'conversation_metadata.json'),
        JSON.stringify({
          conversations: { [conversationId]: { summary: { ProjectID: 'project-id' } } }
        })
      )
      await writeFile(
        join(cache, 'projects.json'),
        JSON.stringify({ 'project-id': `/projects/${origin}` })
      )
      if (origin === 'antigravity') {
        await writeFile(
          join(cache, 'last_conversations.json'),
          JSON.stringify({ '/conflicting-workspace': conversationId })
        )
      }
    }
    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      antigravityBrainDir: join(home, '.gemini', 'antigravity-cli', 'brain'),
      antigravityAppHome: home,
      includeAntigravityIdeSessions: true
    })
    expect(result.sessions).toHaveLength(3)
    for (const session of result.sessions) {
      const origin = antigravitySessionOrigin(session.filePath)
      expect(session.cwd).toBe(origin === 'antigravity' ? null : `/projects/${origin}`)
    }
  })

  it('places a chat by its sole metadata workspace URI only when no other source names a folder', async () => {
    const home = await temporaryHome()
    const brain = join(home, '.gemini', 'antigravity-cli', 'brain')
    await writeAntigravityTranscript(brain, 'chat-one-folder', records('Opened from Orca chat'))
    await writeAntigravityTranscript(brain, 'chat-two-folders', records('Opened in two folders'))
    await writeAntigravityTranscript(brain, 'chat-windows-folder', records('Opened on Windows'))
    await writeAntigravityTranscript(brain, 'chat-conflicted-project', records('Shared project'))
    await writeAntigravityTranscript(brain, 'cli-with-history', records('Opened in a terminal'))
    await writeFile(
      join(dirname(brain), 'history.jsonl'),
      `${JSON.stringify({
        display: 'Opened in a terminal',
        workspace: '/private/tmp/cli',
        timestamp: 1_790_000_000,
        conversationId: 'cli-with-history'
      })}\n`
    )
    const cache = join(dirname(brain), 'cache')
    await mkdir(cache, { recursive: true })
    await writeFile(
      join(cache, 'conversation_metadata.json'),
      JSON.stringify({
        conversations: {
          'chat-one-folder': {
            summary: {
              ProjectID: 'default-cli-project',
              WorkspaceURIs: ['file:///projects/chat%20app']
            }
          },
          'chat-two-folders': {
            summary: {
              ProjectID: 'default-cli-project',
              WorkspaceURIs: ['file:///projects/a', 'file:///projects/b']
            }
          },
          'chat-windows-folder': {
            summary: { ProjectID: 'default-cli-project', WorkspaceURIs: ['file:///c%3A/src/app'] }
          },
          'chat-conflicted-project': {
            summary: { ProjectID: 'shared-project', WorkspaceURIs: ['file:///projects/a'] }
          },
          'cli-with-history': {
            summary: { ProjectID: 'default-cli-project', WorkspaceURIs: ['file:///tmp/cli'] }
          }
        }
      })
    )
    await writeFile(
      join(cache, 'projects.json'),
      JSON.stringify({ '/projects/a': 'shared-project', '/projects/b': 'shared-project' })
    )
    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      antigravityBrainDir: brain,
      antigravityAppHome: home
    })
    const cwdById = new Map(result.sessions.map((session) => [session.sessionId, session.cwd]))
    expect(cwdById.get('chat-one-folder')).toBe('/projects/chat app')
    expect(cwdById.get('chat-two-folders')).toBeNull()
    expect(cwdById.get('chat-windows-folder')).toBe('c:\\src\\app')
    expect(cwdById.get('chat-conflicted-project')).toBeNull()
    expect(cwdById.get('cli-with-history')).toBe('/private/tmp/cli')
  })

  it('discovers IDE and 2.0 history in the selected WSL home without falling into sibling artifacts', async () => {
    const home = await temporaryHome()
    const wslHome = join(home, 'wsl-home')
    for (const origin of origins) {
      await writeAntigravityTranscript(
        join(wslHome, '.gemini', origin, 'brain'),
        conversationId,
        records(origin)
      )
    }
    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      wslHomeDirs: [wslHome],
      includeAntigravityIdeSessions: true,
      platform: 'linux'
    })
    expect(result.sessions).toHaveLength(3)
    expect(result.sessions.every((session) => session.filePath.startsWith(wslHome))).toBe(true)
  })

  it('selects an older full sibling even when the raw discovery cap only retained its compact file', async () => {
    const home = await temporaryHome()
    const brain = join(home, '.gemini', 'antigravity-ide', 'brain')
    const compact = await writeAntigravityTranscript(brain, conversationId, records())
    const full = join(dirname(compact), 'transcript_full.jsonl')
    await writeFile(full, `${jsonLines(records())}\n`)
    await utimes(full, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      antigravityAppHome: home,
      includeAntigravityIdeSessions: true,
      limit: 1,
      limitPerAgent: 1
    })
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.filePath).toBe(full)
  })

  it.skipIf(process.platform === 'win32')(
    'lists all origins despite a FIFO metadata cache and retains transcript workspace fallback',
    async () => {
      const home = await temporaryHome()
      for (const origin of origins) {
        const brain = join(home, '.gemini', origin, 'brain')
        await writeAntigravityTranscript(brain, conversationId, records(origin))
        const cache = join(dirname(brain), 'cache')
        await mkdir(cache, { recursive: true })
        const result = await runProcess({
          program: 'mkfifo',
          args: [join(cache, 'projects.json')],
          timeoutMs: 2000
        })
        expect(result.code).toBe(0)
      }
      const result = await scanAiVaultSessions({
        ...isolatedScanRoots(home),
        antigravityBrainDir: join(home, '.gemini', 'antigravity-cli', 'brain'),
        antigravityAppHome: home,
        includeAntigravityIdeSessions: true
      })
      expect(result.sessions).toHaveLength(3)
      expect(result.issues).toEqual([])
      expect(result.sessions.every((session) => session.cwd === null)).toBe(true)
    },
    5000
  )
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}
