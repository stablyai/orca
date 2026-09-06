import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  completeClaudeTuiExit,
  readClaudeTranscriptEntryUuid,
  readClaudeTranscriptLeafUuid
} from './claude-tui-exit'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Claude TUI exit', () => {
  it('does not sample UUIDs from subagent stdout frames with a parent tool use', () => {
    expect(
      readClaudeTranscriptEntryUuid({
        type: 'assistant',
        uuid: 'subagent-assistant',
        parent_tool_use_id: 'parent-tool'
      })
    ).toBeNull()
    expect(
      readClaudeTranscriptEntryUuid({
        type: 'assistant',
        uuid: 'main-assistant',
        parent_tool_use_id: null
      })
    ).toBe('main-assistant')
  })

  it('reads the authoritative last-prompt leaf from a transcript tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-tui-exit-'))
    roots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(
      transcriptPath,
      [
        { type: 'user', uuid: 'user-one' },
        { type: 'assistant', uuid: 'assistant-one' },
        { type: 'last-prompt', leafUuid: 'chain-head' },
        { type: 'file-history-snapshot', snapshot: {} }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    )

    await expect(readClaudeTranscriptLeafUuid(transcriptPath)).resolves.toBe('chain-head')
  })

  it('falls back to the last persisted message when last-prompt metadata is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-tui-exit-'))
    roots.push(root)
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(
      transcriptPath,
      [
        { type: 'user', uuid: 'user-one' },
        { type: 'assistant', uuid: 'assistant-one' },
        { type: 'system', subtype: 'init', uuid: 'init-frame' },
        { type: 'result', uuid: 'result-frame' },
        { type: 'stream_event', uuid: 'stream-event-frame' }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    )

    await expect(readClaudeTranscriptLeafUuid(transcriptPath)).resolves.toBe('assistant-one')
  })

  it('ignores sidechain messages when selecting a fallback transcript leaf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-tui-sidechain-leaf-'))
    const transcriptPath = join(root, 'session.jsonl')
    await writeFile(
      transcriptPath,
      [
        { type: 'assistant', uuid: 'main-assistant' },
        { type: 'assistant', uuid: 'subagent-assistant', isSidechain: true },
        { type: 'result', uuid: 'result-frame' }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      'utf8'
    )

    await expect(readClaudeTranscriptLeafUuid(transcriptPath)).resolves.toBe('main-assistant')
  })

  it('persists the resumed chain head only after the exact Claude child exits', async () => {
    let resolveExit!: (exit: {
      pid: number
      exitCode: number | null
      signal: string | null
    }) => void
    const exitPromise = new Promise<{
      pid: number
      exitCode: number | null
      signal: string | null
    }>((resolve) => {
      resolveExit = resolve
    })
    const persistHandle = vi.fn(async () => undefined)
    const completion = completeClaudeTuiExit({
      childPid: 4210,
      waitForChildExit: () => exitPromise,
      sessionId: 'provider-session',
      transcriptPath: '/accounts/claude/session.jsonl',
      fence: 7,
      persistHandle,
      readLeafUuid: async () => 'tui-leaf',
      linkId: 'tui-resumed-link',
      now: () => 12
    })

    expect(persistHandle).not.toHaveBeenCalled()
    resolveExit({ pid: 4210, exitCode: 0, signal: null })

    await expect(completion).resolves.toMatchObject({
      link: {
        linkId: 'tui-resumed-link',
        handle: { provider: 'claude', sessionId: 'provider-session', leafUuid: 'tui-leaf' },
        origin: 'resumed',
        mintedAtFence: 7,
        observedAt: 12
      }
    })
    expect(persistHandle).toHaveBeenCalledTimes(1)
  })

  it('refuses another process exit and a missing transcript leaf', async () => {
    const persistHandle = vi.fn(async () => undefined)
    await expect(
      completeClaudeTuiExit({
        childPid: 4210,
        waitForChildExit: async () => ({ pid: 4211, exitCode: 0, signal: null }),
        sessionId: 'provider-session',
        transcriptPath: '/session.jsonl',
        fence: 2,
        persistHandle,
        readLeafUuid: async () => 'leaf'
      })
    ).rejects.toThrow(/did not belong to the Claude child/)
    await expect(
      completeClaudeTuiExit({
        childPid: 4210,
        waitForChildExit: async () => ({ pid: 4210, exitCode: 1, signal: null }),
        sessionId: 'provider-session',
        transcriptPath: '/session.jsonl',
        fence: 2,
        persistHandle,
        readLeafUuid: async () => null
      })
    ).rejects.toThrow(/resumable transcript leaf/)
    expect(persistHandle).not.toHaveBeenCalled()
  })
})
