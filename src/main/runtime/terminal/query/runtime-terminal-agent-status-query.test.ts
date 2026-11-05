import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalAgentStatusQuery } from './runtime-terminal-agent-status-query'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

describe('Hermes terminal status', () => {
  it.each([
    ['✓ TURN_ONE_DONE · grok-4.7', 'idle'],
    ['⏳ TURN_ONE_DONE · grok-4.7', 'working'],
    ['⚠ TURN_ONE_DONE · grok-4.7', 'permission']
  ] as const)(
    'retains native title evidence for an identified Hermes owner: %s',
    async (title, status) => {
      const pty: RuntimePtyWorktreeRecord = {
        ptyId: 'pty',
        incarnationId: null,
        worktreeId: 'wt',
        connectionId: null,
        runtimeSessionOwned: true,
        isWsl: false,
        wslDistro: null,
        launchConfig: null,
        launchToken: null,
        launchIncarnationId: null,
        launchCommandAgent: null,
        agentSessionOwners: [],
        disconnectedAt: null,
        lastExitCode: null,
        lastExitCause: null,
        lastAgentStatusStartedAtEpochMs: 100,
        lastAgentStatusRichInvalidatedAtEpochMs: 100,
        managementTitle: null,
        managementTitleAt: null,
        controllerTitle: null,
        titleObservedAtEpochMs: 100,
        lastOutputAt: 100,
        tailTranscriptBuffer: [],
        tailTranscriptChars: 0,
        tailPendingAnsi: '',
        tailRedrawCursor: null,
        tailTruncated: false,
        tailLinesTotal: 0,
        connected: true,
        launchAgent: 'hermes',
        foregroundAgent: 'hermes',
        title: null,
        titleUpdatedAt: null,
        lastOscTitle: title,
        lastOscTitleAt: 1,
        lastOscTitleEpochMs: 100,
        lastAgentStatus: status,
        lastAgentStatusObservedLive: true,
        tailBuffer: [],
        tailPartialLine: '',
        preview: '',
        waitBlockedAt: null
      }
      const query = new RuntimeTerminalAgentStatusQuery({
        getController: () => null,
        getLivePty: () => ({ pty }),
        getLiveLeaf: () => {
          throw new Error('unexpected leaf read')
        },
        getPrimaryLeaf: () => null,
        getTabTitle: () => null,
        getExplicitStatus: () => null,
        getLifecycleStatus: () => null,
        isRunning: vi.fn(async () => true),
        getTitleDisplayClear: () => null,
        flushPendingBlockedStamp: () => {},
        readScreenClearingBlockedTail: () => null
      })
      await expect(query.getStatus('term')).resolves.toEqual({
        handle: 'term',
        isRunningAgent: true,
        status
      })
    }
  )
})
