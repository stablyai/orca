import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session/agent-session-host-authority'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'

const { routes } = vi.hoisted(() => ({ routes: new Map<string, unknown>() }))

vi.mock('../../../providers/local-pty-provider', () => ({ LocalPtyProvider: class {} }))
vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: (ptyId: string) => routes.get(ptyId),
  registeredPtyProviders: () =>
    [...new Set(routes.values())].map((provider) => ({
      provider,
      hostId: 'local'
    }))
}))

import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { ptyIncarnationById } from '../provider/ownership-state'
import { agentSessionOwners, reconcileAgentSessionOwnerListings } from './agent-session-owners'
import {
  onAgentSessionOwnerAdopted,
  releaseAgentSessionOwnerForFresh
} from './agent-session-owner-release'

const claim = {
  digestVersion: 1 as const,
  keyId: 'key',
  identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  agent: 'claude' as const
}
const surface = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle: 'term_restored'
}

async function ownerOn(ptyId: string): Promise<AgentSessionOwnerBinding> {
  ptyIncarnationById.set(ptyId, 'incarnation-1')
  return (await agentSessionOwners.ensure({ claim, surface, spawn: async () => ({ ptyId }) })).owner
}

function daemon(
  outcome: () => Promise<unknown>,
  owners: () => AgentSessionOwnerBinding[] = () => []
) {
  return {
    providesAgentSessionOwnerListings: () => true,
    supportsAgentSessionClaimRelease: () => true,
    releaseAgentSessionClaim: vi.fn(outcome),
    listProcesses: vi.fn(async () =>
      owners().map((owner) => ({
        id: owner.ptyId,
        incarnationId: 'incarnation-1',
        agentSessionOwners: [owner]
      }))
    )
  } as unknown as IPtyProvider & { releaseAgentSessionClaim: ReturnType<typeof vi.fn> }
}

const deadline = () => Date.now() + 5_000

describe('releaseAgentSessionOwnerForFresh', () => {
  beforeEach(() => {
    routes.clear()
  })
  afterEach(() => {
    for (const owner of agentSessionOwners.list()) {
      agentSessionOwners.release(owner.ptyId)
    }
  })

  it('an in-process terminal releases at main, and a later ensure never adopts it', async () => {
    routes.set('pty-p', new LocalPtyProvider())
    const owner = await ownerOn('pty-p')

    await expect(
      releaseAgentSessionOwnerForFresh({ owner, incarnationId: 'stale', deadline: deadline() })
    ).resolves.toBe(false)
    await expect(
      releaseAgentSessionOwnerForFresh({
        owner,
        incarnationId: 'incarnation-1',
        deadline: deadline()
      })
    ).resolves.toBe(true)
    expect(agentSessionOwners.find(claim)).toBeNull()
  })

  it('an older daemon or a lost acknowledgement keeps the binding and answers false', async () => {
    const oldDaemon = { providesAgentSessionOwnerListings: () => true } as unknown as IPtyProvider
    routes.set('pty-p', oldDaemon)
    const owner = await ownerOn('pty-p')
    const input = { owner, incarnationId: 'incarnation-1', deadline: deadline() }
    await expect(releaseAgentSessionOwnerForFresh(input)).resolves.toBe(false)

    routes.set(
      'pty-p',
      daemon(async () => ({ outcome: 'refused', reason: 'unverifiable' }))
    )
    await expect(releaseAgentSessionOwnerForFresh(input)).resolves.toBe(false)
    expect(agentSessionOwners.find(claim)).toEqual(owner)
  })

  it('an owner adopted while the check was pending is never released', async () => {
    const provider = daemon(async () => ({ outcome: 'released' }))
    routes.set('pty-p', provider)
    const owner = await ownerOn('pty-p')
    const adopted: string[] = []
    const stop = onAgentSessionOwnerAdopted((each) => adopted.push(each.ptyId))
    await agentSessionOwners.ensure({ claim, surface, spawn: async () => ({ ptyId: 'unused' }) })
    stop()

    expect(adopted).toEqual(['pty-p'])
    await expect(
      releaseAgentSessionOwnerForFresh({
        owner,
        incarnationId: 'incarnation-1',
        deadline: deadline()
      })
    ).resolves.toBe(false)
    expect(provider.releaseAgentSessionClaim).not.toHaveBeenCalled()
  })

  it('a listing taken before the daemon released cannot republish the owner', async () => {
    let advertised = true
    const listing = Promise.withResolvers<void>()
    const provider = daemon(
      async () => {
        advertised = false
        return { outcome: 'released' }
      },
      () => (advertised ? [owner] : [])
    )
    routes.set('pty-p', provider)
    const owner = await ownerOn('pty-p')
    // The listing request reads the daemon now, before release, and replies only afterwards.
    const snapshot = [owner]
    vi.mocked(provider.listProcesses).mockImplementationOnce(async () => {
      await listing.promise
      return snapshot.map((each) => ({
        id: each.ptyId,
        incarnationId: 'incarnation-1',
        agentSessionOwners: [each]
      })) as never
    })
    const inFlight = reconcileAgentSessionOwnerListings()

    const released = releaseAgentSessionOwnerForFresh({
      owner,
      incarnationId: 'incarnation-1',
      deadline: deadline()
    })
    await vi.waitFor(() => expect(provider.releaseAgentSessionClaim).toHaveBeenCalled())
    listing.resolve()

    await expect(released).resolves.toBe(true)
    await inFlight
    expect(agentSessionOwners.find(claim)).toBeNull()
  })
})
