import { describe, expect, it, vi } from 'vitest'
import { filesystemPathToFileUri } from '../../shared/file-uri-path'
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
  it('refuses provenance when a structured journal becomes unreadable', async () => {
    await expect(
      nativeChatTranscriptIncludesPath({
        tabs: [
          {
            type: 'agent-session',
            id: 'chat-tab',
            sessionId: 'session-1',
            title: 'Chat',
            agent: 'codex',
            isActive: true
          }
        ],
        context: { tabId: 'chat-tab', sessionId: 'session-1' },
        pathText: '/mnt/data/chart.png',
        absolutePath: '/mnt/data/chart.png',
        readStructuredMessages: async () => {
          throw new Error('Journal unavailable')
        }
      })
    ).resolves.toBe(false)
  })
  it.each(
    ['png', 'pdf', 'svg', 'csv'].flatMap((extension) => [
      { path: `/mnt/data/chart.${extension}`, reference: `sandbox:/mnt/data/chart.${extension}` },
      ...[
        `C:/Users/Agent/Generated reports/chart.${extension}`,
        `//server/reports/chart.${extension}`
      ].map((path) => ({ path, reference: filesystemPathToFileUri(path) }))
    ])
  )(
    'accepts $reference only from the matching structured conversation',
    async ({ path, reference }) => {
      const readStructuredMessages = vi.fn(async () => [
        message('assistant', `![Chart](${reference})`)
      ])
      const tabs: RuntimeMobileSessionClientTab[] = [
        {
          type: 'agent-session',
          id: 'chat-tab',
          sessionId: 'session-1',
          title: 'Chat',
          agent: 'codex',
          isActive: false
        }
      ]
      const args = {
        tabs,
        context: { tabId: 'chat-tab', sessionId: 'session-1' },
        pathText: path,
        absolutePath: path,
        readStructuredMessages
      }
      await expect(nativeChatTranscriptIncludesPath(args)).resolves.toBe(true)
      expect(readStructuredMessages).toHaveBeenCalledWith('session-1')
      readStructuredMessages.mockClear()
      await expect(
        nativeChatTranscriptIncludesPath({
          ...args,
          context: { tabId: 'chat-tab', sessionId: 'another-session' }
        })
      ).resolves.toBe(false)
      expect(readStructuredMessages).not.toHaveBeenCalled()
    }
  )

  it('does not authorize a structured user message or a longer sandbox filename', async () => {
    const tabs: RuntimeMobileSessionClientTab[] = [
      {
        type: 'agent-session',
        id: 'chat-tab',
        sessionId: 'session-1',
        title: 'Chat',
        agent: 'codex',
        isActive: false
      }
    ]
    const args = {
      tabs,
      context: { tabId: 'chat-tab', sessionId: 'session-1' },
      pathText: '/mnt/data/chart.png',
      absolutePath: '/mnt/data/chart.png'
    }
    await expect(
      nativeChatTranscriptIncludesPath({
        ...args,
        readStructuredMessages: async () => [
          message('user', '![Chart](sandbox:/mnt/data/chart.png)')
        ]
      })
    ).resolves.toBe(false)
    await expect(
      nativeChatTranscriptIncludesPath({
        ...args,
        readStructuredMessages: async () => [
          message('assistant', '[Download](sandbox:/mnt/data/chart.png.backup)')
        ]
      })
    ).resolves.toBe(false)
  })

  it('recognizes sandbox image provenance in a terminal-backed conversation', async () => {
    await expect(
      nativeChatTranscriptIncludesPath({
        tabs: [terminalTab()],
        context: { tabId: 'tab-1', sessionId: 'session-1' },
        pathText: '/mnt/data/chart.png',
        absolutePath: '/mnt/data/chart.png',
        readTranscript: async () => ({
          messages: [message('assistant', '![Chart](sandbox:/mnt/data/chart.png)')]
        })
      })
    ).resolves.toBe(true)
  })

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
