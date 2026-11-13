import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'
import { openMobileFileTap } from './mobile-file-tap-open'

type SendRequest = UnvalidatedRpcRequestPort['sendRequest']

function ok(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function activeTerminalState(activated: boolean) {
  return {
    activated,
    activationSeq: 1,
    latestActivationSeq: 1,
    sourceTerminalHandle: 'terminal-1',
    activeTerminalHandle: 'terminal-1',
    activeTabType: 'terminal'
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('openMobileFileTap', () => {
  // Answers like the mobile page bridge, which refuses past 64 pending requests.
  async function openTerminalReadings(readings: string[], existing: Set<string>) {
    let pending = 0
    const client = {
      sendRequest: vi.fn<SendRequest>(async (method, params) => {
        if (method === 'files.open') {
          return ok({ opened: true })
        }
        if (pending >= 64) {
          throw new Error('too many pending requests')
        }
        pending += 1
        await Promise.resolve()
        pending -= 1
        const pathText =
          typeof params === 'object' && params !== null && 'pathText' in params
            ? String(params.pathText)
            : ''
        return ok({
          worktree: 'wt-1',
          relativePath: pathText,
          absolutePath: `/repo/${pathText}`,
          exists: existing.has(pathText),
          isDirectory: false
        })
      })
    }
    openMobileFileTap({
      client,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      candidates: readings.map((pathText) => ({ pathText, line: null, column: null })),
      pushPreviewRoute: vi.fn(),
      openBrowser: vi.fn(),
      triggerOpenFeedback: vi.fn(),
      fetchSessionTabs: vi.fn(),
      getSessionTabs: () => [],
      getActiveSessionTabId: () => 'terminal-tab',
      getActivationState: activeTerminalState,
      switchSessionTab: vi.fn(),
      scheduleDelayedAction: vi.fn()
    })
    await vi.advanceTimersByTimeAsync(0)
    return client.sendRequest.mock.calls
      .filter(([method]) => method === 'files.open')
      .map(([, params]) => params)
  }

  it('still checks the real path behind hundreds of hard-wrap guesses', async () => {
    const guesses = Array.from({ length: 210 }, (_, index) => `src/file${index}.tssrc/next.ts`)
    const opened = await openTerminalReadings(
      [...guesses, 'src/file19.ts'],
      new Set(['src/file19.ts'])
    )
    expect(opened).toEqual([{ worktree: 'id:wt-1', relativePath: 'src/file19.ts' }])
  })
})
