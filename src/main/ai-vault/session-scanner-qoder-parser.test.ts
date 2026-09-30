import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  createQoderSessionParseState,
  createQoderSessionResumeState,
  consumeQoderSessionLine,
  finalizeQoderSessionParseState,
  parseQoderSessionFile,
  parseQoderSessionContent
} from './session-scanner-qoder-parser'
import type { TranscriptMessage } from './session-transcript-consumers'

describe('Qoder session streaming parser', () => {
  it('extracts first user prompt as title, captures cwd, and pushes text to message sink while ignoring thinking and tool_result', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'qoder-parse-test-'))
    const sessionFile = join(sandboxDir, 'test-session-uuid.jsonl')

    const fileLines = [
      JSON.stringify({
        type: 'workspace-directories',
        sessionId: 'test-session-uuid',
        directories: ['/Users/dev/workspace/repo']
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'test-session-uuid',
        cwd: '/Users/dev/workspace/repo',
        timestamp: '2026-09-30T10:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Refactor the authentication module' }]
        }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'test-session-uuid',
        cwd: '/Users/dev/workspace/repo',
        timestamp: '2026-09-30T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Checking project layout' },
            { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
            { type: 'text', text: 'I will inspect the existing auth files.' }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'test-session-uuid',
        cwd: '/Users/dev/workspace/repo',
        timestamp: '2026-09-30T10:00:10.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'index.ts\nauth.ts' }]
        }
      })
    ]

    writeFileSync(sessionFile, fileLines.join('\n'), 'utf8')

    const collectedMessages: TranscriptMessage[] = []
    const messageSink = {
      active: true,
      push: (message: TranscriptMessage) => {
        collectedMessages.push(message)
      }
    }

    try {
      const parsedSession = await parseQoderSessionFile(
        { path: sessionFile, mtimeMs: 1785500000000, modifiedAt: '2026-09-30T12:00:00.000Z' },
        'darwin',
        messageSink
      )

      expect(parsedSession).not.toBeNull()
      expect(parsedSession?.agent).toBe('qoder')
      expect(parsedSession?.sessionId).toBe('test-session-uuid')
      expect(parsedSession?.title).toBe('Refactor the authentication module')
      expect(parsedSession?.cwd).toBe('/Users/dev/workspace/repo')

      // FTS Sink only receives user text prompt and assistant text output
      expect(collectedMessages).toHaveLength(2)
      expect(collectedMessages[0]?.role).toBe('user')
      expect(collectedMessages[0]?.text).toBe('Refactor the authentication module')
      expect(collectedMessages[1]?.role).toBe('assistant')
      expect(collectedMessages[1]?.text).toBe('I will inspect the existing auth files.')
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true })
    }
  })

  it('safely handles empty files, malformed JSON lines, and tool-result only lines', () => {
    const parseState = createQoderSessionParseState({
      path: '/tmp/empty-test.jsonl',
      mtimeMs: 1785500000000,
      modifiedAt: '2026-09-30T12:00:00.000Z'
    })

    consumeQoderSessionLine(parseState, '')
    consumeQoderSessionLine(parseState, '{ invalid json')
    consumeQoderSessionLine(
      parseState,
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'terminal output only' }]
        }
      })
    )

    const finalizedSession = finalizeQoderSessionParseState(parseState, 'darwin')
    expect(finalizedSession).not.toBeNull()
    expect(finalizedSession?.title).toBe('Untitled Qoder Session')
  })

  it('supports incremental updates through resumable state and state cloning', async () => {
    const sessionFilePath = '/Users/dev/.qoder/projects/workspace/session-resumable.jsonl'
    const initialCandidateFile = {
      path: sessionFilePath,
      mtimeMs: 1785500000000,
      modifiedAt: '2026-09-30T10:00:00.000Z'
    }

    const collectedMessages: TranscriptMessage[] = []
    const messageSink = {
      active: true,
      push: (messageItem: TranscriptMessage) => {
        collectedMessages.push(messageItem)
      }
    }

    const resumeState = createQoderSessionResumeState(initialCandidateFile, messageSink)

    const workspaceLine = JSON.stringify({
      type: 'workspace-directories',
      sessionId: 'session-resumable',
      directories: ['/Users/dev/workspace/repo']
    })
    const firstPromptLine = JSON.stringify({
      type: 'user',
      sessionId: 'session-resumable',
      timestamp: '2026-09-30T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Initial prompt message' }]
      }
    })

    resumeState.consumeLine(workspaceLine)
    resumeState.consumeLine(firstPromptLine)

    const sessionIdentity = resumeState.identity?.()
    expect(sessionIdentity?.sessionId).toBe('session-resumable')
    expect(sessionIdentity?.title).toBe('Initial prompt message')

    const clonedResumeState = resumeState.clone()
    const updatedCandidateFile = {
      path: sessionFilePath,
      mtimeMs: 1785500300000,
      modifiedAt: '2026-09-30T10:05:00.000Z'
    }
    clonedResumeState.touchFile(updatedCandidateFile)

    const secondPromptLine = JSON.stringify({
      type: 'user',
      sessionId: 'session-resumable',
      timestamp: '2026-09-30T10:05:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Followup prompt question' }]
      }
    })
    clonedResumeState.consumeLine(secondPromptLine)

    const finalizedClonedSession = await clonedResumeState.finalize('darwin')
    expect(finalizedClonedSession).not.toBeNull()
    expect(finalizedClonedSession?.title).toBe('Initial prompt message')
    expect(finalizedClonedSession?.messageCount).toBe(2)
    expect(finalizedClonedSession?.updatedAt).toBe('2026-09-30T10:05:00.000Z')
    expect(finalizedClonedSession?.modifiedAt).toBe('2026-09-30T10:05:00.000Z')
  })

  it('parses remote session content from string and async stream, including lines with unicode line separators', async () => {
    const candidateFile = {
      path: '/home/dev/.qoder/projects/remote-project/qoder-remote.jsonl',
      mtimeMs: 1785500000000,
      modifiedAt: '2026-09-30T10:00:00.000Z'
    }

    const contentLines = [
      JSON.stringify({
        type: 'workspace-directories',
        sessionId: 'qoder-remote',
        directories: ['/home/dev/remote-project']
      }),
      JSON.stringify({
        type: 'message',
        sessionId: 'qoder-remote',
        timestamp: '2026-09-30T10:00:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Prompt with unicode line separator \u2028 and paragraph \u2029 separator'
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'message',
        sessionId: 'qoder-remote',
        timestamp: '2026-09-30T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Remote response' }]
        }
      })
    ]

    const sessionFromString = await parseQoderSessionContent(
      candidateFile,
      contentLines.join('\n'),
      'linux'
    )
    expect(sessionFromString).not.toBeNull()
    expect(sessionFromString?.sessionId).toBe('qoder-remote')
    expect(sessionFromString?.cwd).toBe('/home/dev/remote-project')
    expect(sessionFromString?.title).toBe(
      'Prompt with unicode line separator and paragraph separator'
    )
    expect(sessionFromString?.messageCount).toBe(2)

    async function* makeAsyncStream() {
      for (const line of contentLines) {
        yield line
      }
    }
    const sessionFromStream = await parseQoderSessionContent(
      candidateFile,
      makeAsyncStream(),
      'linux'
    )
    expect(sessionFromStream).not.toBeNull()
    expect(sessionFromStream?.sessionId).toBe('qoder-remote')
    expect(sessionFromStream?.messageCount).toBe(2)
  })
})
