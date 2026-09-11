import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
import type { CommitMessageModelCapability } from '../../../../../../shared/commit-message-agent-spec'
import {
  clearWorkerLaunchModelAuthorityCacheForTests,
  resolveWorkerLaunchModelAuthority,
  type WorkerLaunchModelDiscoveryRuntime
} from './worker-launch-model-authority'

const CLAUDE_CATALOG = getAgentSessionOptionCatalog('claude')!

type ClaudeAuthState = {
  accounts: { id: string; updatedAt: number }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: { host: string | null; wsl: Record<string, string | null> }
}

function liveModel(id: string): CommitMessageModelCapability {
  return { id, label: id }
}

function probeSuccess(models: readonly CommitMessageModelCapability[]): unknown {
  return {
    success: true,
    catalogOrigin: 'probe',
    models,
    defaultModelId: models[0]?.id ?? '',
    capability: {
      id: 'claude',
      label: 'Claude',
      modelSource: 'dynamic',
      models,
      defaultModelId: ''
    }
  }
}

function accountAwareRuntime(args: {
  authState: () => ClaudeAuthState
  hostKey?: string
  respond?: () => unknown
}): { runtime: WorkerLaunchModelDiscoveryRuntime; discover: ReturnType<typeof vi.fn> } {
  const discover = vi.fn(async () =>
    args.respond ? await args.respond() : probeSuccess([liveModel('opus')])
  )
  return {
    runtime: {
      discoverRuntimeCommitMessageModels: discover,
      getAccountsSnapshot: () => ({ claude: args.authState() }),
      resolveRuntimeCommitMessageDiscoveryHostKey: async () => args.hostKey ?? 'local'
    } as never,
    discover
  }
}

async function resolve(runtime: WorkerLaunchModelDiscoveryRuntime) {
  return await resolveWorkerLaunchModelAuthority({
    catalog: CLAUDE_CATALOG,
    agent: 'claude',
    runtime,
    worktreeSelector: 'id:wt'
  })
}

describe('worker launch model authority account cache', () => {
  beforeEach(() => {
    clearWorkerLaunchModelAuthorityCacheForTests()
  })

  it('does not reuse a Claude catalog after the active account changes', async () => {
    let activeAccountId = 'account-a'
    const { runtime, discover } = accountAwareRuntime({
      authState: () => ({
        accounts: [
          { id: 'account-a', updatedAt: 1 },
          { id: 'account-b', updatedAt: 1 }
        ],
        activeAccountId
      }),
      respond: () => probeSuccess([liveModel(`${activeAccountId}-model`)])
    })

    const first = await resolve(runtime)
    activeAccountId = 'account-b'
    const second = await resolve(runtime)

    expect(discover).toHaveBeenCalledTimes(2)
    expect(first.modelIds).toContain('account-a-model')
    expect(second.modelIds).toContain('account-b-model')
  })

  it('invalidates the catalog when the selected account is reauthenticated', async () => {
    let updatedAt = 1
    const { runtime, discover } = accountAwareRuntime({
      authState: () => ({
        accounts: [{ id: 'account-a', updatedAt }],
        activeAccountId: 'account-a'
      })
    })

    await resolve(runtime)
    updatedAt = 2
    await resolve(runtime)

    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('uses the selected account for the executing WSL distro', async () => {
    let selectedAccountId = 'account-a'
    const { runtime, discover } = accountAwareRuntime({
      hostKey: 'wsl:Ubuntu',
      authState: () => ({
        accounts: [
          { id: 'account-a', updatedAt: 1 },
          { id: 'account-b', updatedAt: 1 }
        ],
        activeAccountId: null,
        activeAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: selectedAccountId }
        }
      })
    })

    await resolve(runtime)
    selectedAccountId = 'account-b'
    await resolve(runtime)

    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('does not apply local managed-account changes to an SSH host catalog', async () => {
    let activeAccountId = 'account-a'
    const { runtime, discover } = accountAwareRuntime({
      hostKey: 'ssh:box',
      authState: () => ({
        accounts: [
          { id: 'account-a', updatedAt: 1 },
          { id: 'account-b', updatedAt: 1 }
        ],
        activeAccountId
      })
    })

    await resolve(runtime)
    activeAccountId = 'account-b'
    await resolve(runtime)

    expect(discover).toHaveBeenCalledOnce()
  })

  it('does not persist a catalog when the account identity is unavailable', async () => {
    const discover = vi.fn(async () => probeSuccess([liveModel('opus')]))
    const runtime = {
      discoverRuntimeCommitMessageModels: discover,
      getAccountsSnapshot: () => {
        throw new Error('accounts unavailable')
      },
      resolveRuntimeCommitMessageDiscoveryHostKey: async () => 'local'
    } as never

    await resolve(runtime)
    await resolve(runtime)

    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('discards an answer when the account changes during discovery', async () => {
    let activeAccountId = 'account-a'
    let markStarted: (() => void) | undefined
    let release: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { runtime, discover } = accountAwareRuntime({
      authState: () => ({
        accounts: [
          { id: 'account-a', updatedAt: 1 },
          { id: 'account-b', updatedAt: 1 }
        ],
        activeAccountId
      }),
      respond: async () => {
        markStarted!()
        await blocked
        return probeSuccess([liveModel('account-a-model')])
      }
    })

    const first = resolve(runtime)
    await started
    activeAccountId = 'account-b'
    release!()

    expect((await first).source).toBe('seed')
    await resolve(runtime)
    expect(discover).toHaveBeenCalledTimes(2)
  })
})
