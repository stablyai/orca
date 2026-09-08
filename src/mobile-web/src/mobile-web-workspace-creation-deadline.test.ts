import { afterEach, expect, it, vi } from 'vitest'
import { WORKTREE_CREATE_TIMEOUT_MS } from '../../shared/mobile-web/host-operation-timeouts'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

afterEach(() => vi.useRealTimers())

it.each(['creationCreateBlank', 'creationCreateFromSource'] as const)(
  '%s waits for slow workspace creation and still has a deadline',
  async (operation) => {
    vi.useFakeTimers()
    const postMessage = vi.fn(() => true)
    const client = new MobileWebBridgeClient({
      context: { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) },
      grants: [
        {
          capability: 'workspace',
          operation,
          limits: {
            maxRequestBytes: 1024,
            maxResponseBytes: 1024,
            maxConcurrent: 2,
            rateCapacity: 4,
            rateRefillPerSecond: 1
          }
        }
      ],
      postMessage
    })
    const result =
      operation === 'creationCreateBlank'
        ? client.workspaceCreationCreate.createBlank({
            repoId: 'repo',
            baseName: 'workspace',
            nameWasGenerated: false,
            agentChoice: 'blank',
            setupDecision: 'run'
          })
        : client.workspaceCreationCreate.createFromSource({
            targetRepoId: 'repo',
            selection: { kind: 'new-branch', branchName: 'feature' },
            agentChoice: 'blank',
            setupDecision: 'run'
          })
    const settled = vi.fn()
    void result.then(settled, settled)
    try {
      await vi.advanceTimersByTimeAsync(20_000)
      expect(settled).not.toHaveBeenCalled()
      expect(postMessage).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_TIMEOUT_MS - 20_000)
      await expect(result).rejects.toMatchObject({ code: 'timeout' })
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'cancel', target: 'request' })
      )
    } finally {
      client.dispose()
    }
  }
)
