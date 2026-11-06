import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS } from './worktree-create-idempotency-policy'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'

type Attempt = {
  method: string
  params: Record<string, unknown>
  timeoutMs?: number
  keepaliveTotalMs?: number
}

const IDEMPOTENT_CREATE_SUPPORT = { dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS }

function scriptedLaunchClient(
  outcomes: Array<
    | { launched: string }
    | { created: string }
    | { errorCode: string; errorMessage?: string }
    | { throws: unknown; dropsConnection?: boolean }
  >,
  attempts: Attempt[]
): RpcClient & { reconnect: () => void } {
  let call = 0
  let state: ConnectionState = 'connected'
  const listeners = new Set<(next: ConnectionState) => void>()
  const setState = (next: ConnectionState): void => {
    state = next
    for (const listener of listeners) {
      listener(next)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The retry loop reads only these members of RpcClient; spelling out the rest would be a fake transport pretending to be a real one.
  return {
    reconnect: () => setState('connected'),
    getState: () => state,
    getLastInboundAt: () => null,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendRequest: async (
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number; keepaliveTotalMs?: number }
    ) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The port is untyped by construction; the suite asserts on what was sent, not on its declared shape.
      attempts.push({
        method,
        params: (params ?? {}) as Record<string, unknown>,
        timeoutMs: options?.timeoutMs,
        keepaliveTotalMs: options?.keepaliveTotalMs
      })
      const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
      call += 1
      if ('throws' in outcome) {
        if (outcome.dropsConnection) {
          setState('reconnecting')
        }
        throw outcome.throws
      }
      if ('errorCode' in outcome) {
        return {
          id: '1',
          ok: false,
          error: { code: outcome.errorCode, message: outcome.errorMessage ?? outcome.errorCode },
          _meta: { runtimeId: 'r' }
        }
      }
      return {
        id: '1',
        ok: true,
        result:
          'launched' in outcome
            ? {
                worktreeId: outcome.launched,
                outcome: { kind: 'terminal', handle: 'term_x' },
                receipt: {
                  mode: 'terminal',
                  preferred: 'terminal',
                  reason: 'user_default',
                  detail: 'Terminal selected'
                }
              }
            : { worktree: { id: outcome.created } },
        _meta: { runtimeId: 'r' }
      }
    }
  } as unknown as RpcClient & { reconnect: () => void }
}

describe('agent.launch operation id', () => {
  function launchRetry(args: {
    client: RpcClient
    attempts: Attempt[]
    replay?: boolean
    supported?: boolean
    worktreeCreateIdempotency?: false
    mintLaunchOperationId?: () => string
  }): Promise<WorktreeCreateResult> {
    let minted = 0
    return createWorktreeWithNameRetry({
      client: args.client,
      baseName: 'otter',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: args.worktreeCreateIdempotency ?? IDEMPOTENT_CREATE_SUPPORT,
      mintMutationId: () => 'key-launch',
      agentLaunch: {
        agent: 'claude',
        supported: args.supported === false ? false : { replay: args.replay !== false }
      },
      mintLaunchOperationId: args.mintLaunchOperationId ?? (() => `op-${(minted += 1)}`)
    })
  }

  it('shows required setup failure without relaunching or creating another workspace', async () => {
    const attempts: Attempt[] = []
    const message =
      'Setup failed, so Claude was not started. Fix or rerun setup, then start Claude in this workspace.'
    const client = scriptedLaunchClient(
      [{ errorCode: 'agent_launch_setup_not_completed', errorMessage: message }],
      attempts
    )
    await expect(launchRetry({ client, attempts })).resolves.toEqual({ error: message })
    expect(attempts.map(({ method }) => method)).toEqual(['agent.launchReplay'])
    // Ordinary idle budget; only the host's keepalives stretch it, up to setup's deadline.
    expect(attempts[0]?.timeoutMs).toBe(10 * 60_000)
    expect(attempts[0]?.keepaliveTotalMs).toBeGreaterThan(2 * 60 * 60 * 1000)
  })
})
