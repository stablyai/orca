import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildAiVaultSessionRgArgs,
  lastPathSeparator,
  parentTranscriptDirectory,
  siblingTranscriptPath
} from '../../shared/ai-vault-session-rg-args'
import { createAiVaultTestSession } from '../../shared/ai-vault-session-test-session'
import { checkRgAvailable } from '../ipc/rg-availability'
import { searchAiVaultSessionsWithRg } from './session-transcript-rg'

const USER_TOKEN = 'rg-scope-user-prompt'
const ASSISTANT_TOKEN = 'rg-scope-assistant-prose'
const TOOL_TOKEN = 'rg-scope-tool-secret-only'
const ERROR_TOKEN = 'rg-scope-rate-limit-crash'

async function writeFixtureSession(fileName: string, lines: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-vault-rg-'))
  const filePath = join(directory, fileName)
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8')
  return filePath
}

describe('buildAiVaultSessionRgArgs', () => {
  it('asks the real rg binary for files-with-matches and does not invent a JS scan', () => {
    expect(buildAiVaultSessionRgArgs('pairing', ['/tmp/a.jsonl'])).toEqual([
      '--files-with-matches',
      '--hidden',
      '--no-ignore',
      '--ignore-case',
      '--fixed-strings',
      '--max-filesize',
      '8M',
      '--',
      'pairing',
      '/tmp/a.jsonl'
    ])
  })

  it('splits mixed-separator paths at the last slash or backslash', () => {
    expect(lastPathSeparator('C:\\Users/me\\agent\\session.jsonl')).toEqual({
      index: 'C:\\Users/me\\agent\\session.jsonl'.lastIndexOf('\\'),
      separator: '\\'
    })
    expect(siblingTranscriptPath('C:\\Users/me\\agent\\session.jsonl', 'chat_history.jsonl')).toBe(
      'C:\\Users/me\\agent\\chat_history.jsonl'
    )
    expect(parentTranscriptDirectory('C:/Users\\me/agent/session.jsonl')).toBe('C:/Users\\me/agent')
  })
})

describe('searchAiVaultSessionsWithRg', () => {
  it('isolates full text, without-tools, user, assistant, and error scopes', async () => {
    if (!(await checkRgAvailable())) {
      return
    }

    const mixedPath = await writeFixtureSession('mixed.jsonl', [
      JSON.stringify({
        type: 'user',
        message: { content: `Please look at ${USER_TOKEN}` }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: `I would retry ${ASSISTANT_TOKEN}` },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${TOOL_TOKEN}` } }
          ]
        }
      }),
      JSON.stringify({
        type: 'error',
        error: { message: `${ERROR_TOKEN} while calling the model` }
      })
    ])
    const toolOnlyPath = await writeFixtureSession('tool-only.jsonl', [
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: TOOL_TOKEN }]
        }
      })
    ])

    const mixed = createAiVaultTestSession({
      id: 'claude:mixed',
      title: 'Mixed transcript',
      filePath: mixedPath
    })
    const toolOnly = createAiVaultTestSession({
      id: 'claude:tool-only',
      title: 'Tool only transcript',
      filePath: toolOnlyPath
    })
    const sessionsById = new Map([
      [mixed.id, mixed],
      [toolOnly.id, toolOnly]
    ])
    const sessionIds = [mixed.id, toolOnly.id]

    const fullTool = await searchAiVaultSessionsWithRg(
      { query: TOOL_TOKEN, searchScope: 'full', sessionIds },
      sessionsById
    )
    expect(fullTool.usedRg).toBe(true)
    expect(fullTool.matchedIds.sort()).toEqual(['claude:mixed', 'claude:tool-only'])

    const withoutTools = await searchAiVaultSessionsWithRg(
      { query: TOOL_TOKEN, searchScope: 'fullWithoutTools', sessionIds },
      sessionsById
    )
    expect(withoutTools.usedRg).toBe(true)
    expect(withoutTools.matchedIds).toEqual([])

    const userHits = await searchAiVaultSessionsWithRg(
      { query: USER_TOKEN, searchScope: 'user', sessionIds },
      sessionsById
    )
    expect(userHits.matchedIds).toEqual(['claude:mixed'])

    const assistantHits = await searchAiVaultSessionsWithRg(
      { query: ASSISTANT_TOKEN, searchScope: 'assistant', sessionIds },
      sessionsById
    )
    expect(assistantHits.matchedIds).toEqual(['claude:mixed'])

    const assistantTool = await searchAiVaultSessionsWithRg(
      { query: TOOL_TOKEN, searchScope: 'assistant', sessionIds },
      sessionsById
    )
    expect(assistantTool.matchedIds).toEqual([])

    const errorHits = await searchAiVaultSessionsWithRg(
      { query: ERROR_TOKEN, searchScope: 'errors', sessionIds },
      sessionsById
    )
    expect(errorHits.matchedIds).toEqual(['claude:mixed'])

    const userFromError = await searchAiVaultSessionsWithRg(
      { query: ERROR_TOKEN, searchScope: 'user', sessionIds },
      sessionsById
    )
    expect(userFromError.matchedIds).toEqual([])
  })

  it('does not spawn desktop rg for SSH-owned transcript paths', async () => {
    const remote = createAiVaultTestSession({
      id: 'claude:ssh',
      executionHostId: 'ssh:dev-box',
      filePath: '/home/ada/.claude/projects/remote.jsonl',
      title: 'Remote pairing notes'
    })
    const result = await searchAiVaultSessionsWithRg(
      { query: 'pairing', searchScope: 'full', sessionIds: [remote.id] },
      new Map([[remote.id, remote]])
    )
    expect(result.usedRg).toBe(false)
    expect(result.matchedIds).toEqual([])
  })
})
