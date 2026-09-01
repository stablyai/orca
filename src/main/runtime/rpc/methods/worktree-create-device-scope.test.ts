// P1-14: worktree.create's host-atomic agentLaunch must carry the AUTHENTICATED
// paired device into createManagedWorktree, so its pre-git capacity reservation
// and idempotency key are per device rather than per client kind.
import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { WORKTREE_METHODS } from './worktree'

const AGENT_LAUNCH = {
  selection: { kind: 'default' as const },
  allowEmptyPromptLaunch: true
}

function worktreeCreateHandler(): (params: unknown, ctx: RpcContext) => Promise<unknown> {
  const found = WORKTREE_METHODS.find((candidate) => candidate.name === 'worktree.create')
  if (!found) {
    throw new Error('worktree.create method missing')
  }
  return found.handler as (params: unknown, ctx: RpcContext) => Promise<unknown>
}

async function createArgs(
  ctx: Partial<RpcContext>,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const createManagedWorktree = vi.fn(async (_args: Record<string, unknown>) => ({
    created: true
  }))
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    dedupeWorktreeCreate: <T>(
      _repo: string,
      _mutationId: string | undefined,
      run: () => Promise<T>
    ) => run(),
    showRepo: vi.fn().mockResolvedValue({ id: 'repo-1', path: '/repo', kind: 'git' }),
    createManagedWorktree
  }
  await worktreeCreateHandler()(
    { repo: 'repo-1', name: 'wt', agentLaunch: AGENT_LAUNCH, ...params },
    { runtime, ...ctx } as unknown as RpcContext
  )
  return createManagedWorktree.mock.calls[0]![0]
}

describe('worktree.create device-scoped agent launch', () => {
  it('forwards the authenticated paired device alongside the client kind', async () => {
    const args = await createArgs({
      clientKind: 'mobile',
      pairedDeviceId: 'device-a'
    })

    expect(args).toMatchObject({
      agentLaunch: AGENT_LAUNCH,
      agentLaunchClientKind: 'mobile',
      agentLaunchDeviceId: 'device-a'
    })
  })

  it('omits the device id (never undefined-valued) for an in-process caller', async () => {
    // Keeps the coarse/local principal that pre-device persisted rows were
    // reserved under, so they stay forgettable after the upgrade.
    const args = await createArgs({})

    expect(args.agentLaunchClientKind).toBeUndefined()
    expect('agentLaunchDeviceId' in args).toBe(false)
  })

  it('takes the device id from the envelope, never from client params', async () => {
    const args = await createArgs(
      { clientKind: 'mobile', pairedDeviceId: 'device-a' },
      { agentLaunchDeviceId: 'device-victim' }
    )

    expect(args.agentLaunchDeviceId).toBe('device-a')
  })

  it('sends no device id on the legacy (no agentLaunch) create path', async () => {
    const args = await createArgs(
      { clientKind: 'mobile', pairedDeviceId: 'device-a' },
      { agentLaunch: undefined }
    )

    expect('agentLaunchDeviceId' in args).toBe(false)
  })
})
