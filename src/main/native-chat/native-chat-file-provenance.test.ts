import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { RuntimeMobileSessionClientTab } from '../../shared/runtime-types'
import { nativeChatTranscriptIncludesPath } from './native-chat-file-provenance'

function terminalTab(): RuntimeMobileSessionClientTab {
  return {
    type: 'terminal',
    id: 'tab-1',
    title: 'Codex',
    parentTabId: 'parent-1',
    leafId: 'leaf-1',
    launchAgent: 'codex',
    agentStatus: {
      state: 'done',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey: 'parent-1:leaf-1',
      stateHistory: [],
      agentType: 'codex',
      providerSession: {
        key: 'session_id',
        id: 'session-1',
        transcriptPath: '/host/transcripts/session-1.jsonl'
      }
    },
    isActive: true,
    status: 'ready',
    terminal: 'term-1'
  }
}

function message(role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return {
    id: `${role}-1`,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('nativeChatTranscriptIncludesPath', () => {
  it('accepts a path in recent assistant output from the host-bound session', async () => {
    const readTranscript = vi.fn(async () => ({
      messages: [message('assistant', 'Open ~/orca-plans/result.html to review it.')]
    }))

    await expect(
      nativeChatTranscriptIncludesPath({
        tabs: [terminalTab()],
        context: { tabId: 'tab-1', sessionId: 'session-1' },
        pathText: '~/orca-plans/result.html',
        absolutePath: '/Users/ada/orca-plans/result.html',
        readTranscript
      })
    ).resolves.toBe(true)
    expect(readTranscript).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: 'session-1',
      transcriptPath: '/host/transcripts/session-1.jsonl',
      limit: 2000
    })
  })

  it('rejects a client session identity that does not match the host tab', async () => {
    const readTranscript = vi.fn()

    await expect(
      nativeChatTranscriptIncludesPath({
        tabs: [terminalTab()],
        context: { tabId: 'tab-1', sessionId: 'forged-session' },
        pathText: '/etc/passwd',
        absolutePath: '/etc/passwd',
        readTranscript
      })
    ).resolves.toBe(false)
    expect(readTranscript).not.toHaveBeenCalled()
  })

  it('accepts a path followed by a sentence-final period', async () => {
    const readTranscript = vi.fn(async () => ({
      messages: [message('assistant', 'Open /tmp/orca-pr14166-external.txt.')]
    }))

    await expect(
      nativeChatTranscriptIncludesPath({
        tabs: [terminalTab()],
        context: { tabId: 'tab-1', sessionId: 'session-1' },
        pathText: '/tmp/orca-pr14166-external.txt',
        absolutePath: '/tmp/orca-pr14166-external.txt',
        readTranscript
      })
    ).resolves.toBe(true)
  })

  it('does not accept a longer filename sharing the requested path prefix', async () => {
    const readTranscript = vi.fn(async () => ({
      messages: [message('assistant', 'Open /tmp/orca-pr14166-external.txt.backup')]
    }))

    await expect(
      nativeChatTranscriptIncludesPath({
        tabs: [terminalTab()],
        context: { tabId: 'tab-1', sessionId: 'session-1' },
        pathText: '/tmp/orca-pr14166-external.txt',
        absolutePath: '/tmp/orca-pr14166-external.txt',
        readTranscript
      })
    ).resolves.toBe(false)
  })

  it('does not treat user-authored transcript text as agent provenance', async () => {
    const readTranscript = vi.fn(async () => ({
      messages: [message('user', 'Please open /etc/passwd')]
    }))

    await expect(
      nativeChatTranscriptIncludesPath({
        tabs: [terminalTab()],
        context: { tabId: 'tab-1', sessionId: 'session-1' },
        pathText: '/etc/passwd',
        absolutePath: '/etc/passwd',
        readTranscript
      })
    ).resolves.toBe(false)
  })
})
