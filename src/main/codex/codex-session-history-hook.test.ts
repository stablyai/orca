import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { exportSessionMock } = vi.hoisted(() => ({
  exportSessionMock: vi.fn()
}))

vi.mock('./codex-session-managed-export', () => ({
  exportManagedCodexSessionToSystemHistory: exportSessionMock
}))

import {
  scheduleManagedCodexSessionExportFromHook,
  type CodexSessionHistoryHookEvent
} from './codex-session-history-hook'

const managedTranscriptPath = '/managed/.codex/sessions/2026/07/10/rollout-orca.jsonl'

function createCodexSessionStart(
  overrides: Partial<CodexSessionHistoryHookEvent> = {}
): CodexSessionHistoryHookEvent {
  return {
    connectionId: null,
    hookEventName: 'SessionStart',
    payload: { state: 'done', prompt: '', agentType: 'codex' },
    providerSession: {
      key: 'session_id',
      id: '00000000-0000-4000-8000-000000004444',
      transcriptPath: managedTranscriptPath
    },
    ...overrides
  }
}

describe('scheduleManagedCodexSessionExportFromHook', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    exportSessionMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exports a local managed transcript after a live Codex SessionStart', () => {
    expect(
      scheduleManagedCodexSessionExportFromHook(
        createCodexSessionStart(),
        '/custom/system-codex-home'
      )
    ).toBe(true)
    expect(exportSessionMock).not.toHaveBeenCalled()

    vi.runAllTimers()

    expect(exportSessionMock).toHaveBeenCalledWith(
      managedTranscriptPath,
      '/custom/system-codex-home'
    )
  })

  it.each([
    ['remote Codex event', { connectionId: 'ssh-connection' }],
    ['replayed Codex event', { isReplay: true }],
    ['non-lifecycle Codex event', { hookEventName: 'PreToolUse' }],
    [
      'non-Codex event',
      { payload: { state: 'done' as const, prompt: '', agentType: 'claude' as const } }
    ],
    ['event without a transcript path', { providerSession: undefined }]
  ])('ignores a %s', (_label, overrides) => {
    expect(scheduleManagedCodexSessionExportFromHook(createCodexSessionStart(overrides))).toBe(
      false
    )
    vi.runAllTimers()
    expect(exportSessionMock).not.toHaveBeenCalled()
  })

  it('retries on the next prompt when SessionStart ran before the rollout existed', () => {
    exportSessionMock.mockReturnValueOnce('ignored').mockReturnValueOnce('linked')
    expect(scheduleManagedCodexSessionExportFromHook(createCodexSessionStart())).toBe(true)
    vi.runAllTimers()

    expect(
      scheduleManagedCodexSessionExportFromHook(
        createCodexSessionStart({ hookEventName: 'UserPromptSubmit' })
      )
    ).toBe(true)
    vi.runAllTimers()

    expect(exportSessionMock).toHaveBeenCalledTimes(2)
  })
})
