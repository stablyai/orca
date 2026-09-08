import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SKILL_DISCOVER_CAPABILITY,
  SKILL_DISCOVER_UPDATE_REQUIRED_MESSAGE
} from '../../shared/skill-install-capability'
import {
  clearSkillDiscoveryCaches,
  discoverSkillsOnTarget,
  forgetSshSkillDiscoveryCapabilities
} from './skill-discovery-target'

const EMPTY_RESULT = { skills: [], sources: [], scannedAt: 1 }

/** A relay stub that advertises discovery and answers one scan. */
function relayProvider(
  result: unknown = EMPTY_RESULT,
  capabilities: readonly string[] = [SKILL_DISCOVER_CAPABILITY]
) {
  const requestHostRpc = vi.fn(async (method: string) =>
    method === 'relay.status' ? { capabilities: [...capabilities] } : result
  )
  return { provider: { requestHostRpc } as never, requestHostRpc }
}

function sshTarget(connectionId: string, path = '/remote/repo') {
  return {
    kind: 'ssh' as const,
    connectionId,
    workspace: { kind: 'worktree' as const, id: 'worktree-1', path }
  }
}

describe('SSH skill discovery target', () => {
  beforeEach(() => clearSkillDiscoveryCaches())

  it('scans the SSH host instead of this machine', async () => {
    const { provider, requestHostRpc } = relayProvider({
      ...EMPTY_RESULT,
      skills: [
        {
          id: 'docs',
          name: 'docs',
          description: null,
          providers: ['agent-skills'],
          sourceKind: 'repo',
          sourceLabel: 'Repo skills',
          rootPath: '/remote/repo/.agents/skills',
          directoryPath: '/remote/repo/.agents/skills/docs',
          skillFilePath: '/remote/repo/.agents/skills/docs/SKILL.md',
          installed: true,
          updatedAt: null
        }
      ]
    })

    const result = await discoverSkillsOnTarget(sshTarget('target-1'), [], {
      sshProvider: provider
    })

    expect(result.skills.map((skill) => skill.name)).toEqual(['docs'])
    expect(requestHostRpc).toHaveBeenCalledWith(
      'skills.discover',
      { workspace: { kind: 'worktree', id: 'worktree-1', path: '/remote/repo' } },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  // The scan cache is keyed by target. Two hosts share every absolute path, so a
  // key without the connection id would serve one host's skills for another.
  it('never shares one host cached scan with a different host', async () => {
    const first = relayProvider({ ...EMPTY_RESULT, scannedAt: 111 })
    const second = relayProvider({ ...EMPTY_RESULT, scannedAt: 222 })

    const a = await discoverSkillsOnTarget(sshTarget('target-1'), [], {
      sshProvider: first.provider
    })
    const b = await discoverSkillsOnTarget(sshTarget('target-2'), [], {
      sshProvider: second.provider
    })

    expect(a.scannedAt).toBe(111)
    expect(b.scannedAt).toBe(222)
    expect(second.requestHostRpc).toHaveBeenCalled()
  })

  it('shares one scan between concurrent callers on the same host', async () => {
    const { provider, requestHostRpc } = relayProvider()

    await Promise.all([
      discoverSkillsOnTarget(sshTarget('target-1'), [], { sshProvider: provider }),
      discoverSkillsOnTarget(sshTarget('target-1'), [], { sshProvider: provider })
    ])

    const scans = requestHostRpc.mock.calls.filter(([method]) => method === 'skills.discover')
    expect(scans).toHaveLength(1)
  })

  // Why capability-gated: an older relay answers method-not-found, which reaches
  // the picker as an unexplained empty list rather than "reconnect this host".
  it('asks for a reconnect when the relay does not advertise discovery', async () => {
    const { provider, requestHostRpc } = relayProvider(EMPTY_RESULT, ['skills.install.v1'])

    await expect(
      discoverSkillsOnTarget(sshTarget('target-1'), [], { sshProvider: provider })
    ).rejects.toThrow(SKILL_DISCOVER_UPDATE_REQUIRED_MESSAGE)

    const scans = requestHostRpc.mock.calls.filter(([method]) => method === 'skills.discover')
    expect(scans).toHaveLength(0)
  })

  // The skew message tells the user to reconnect. If the memoized capability
  // answer outlived the session, doing exactly that would leave the message
  // stuck forever on a host that now supports discovery.
  it('re-probes capabilities after the connection is torn down', async () => {
    const stale = relayProvider(EMPTY_RESULT, ['skills.install.v1'])
    await expect(
      discoverSkillsOnTarget(sshTarget('target-1'), [], { sshProvider: stale.provider })
    ).rejects.toThrow(SKILL_DISCOVER_UPDATE_REQUIRED_MESSAGE)

    // Only the teardown invalidation — no full cache clear, or this would pass
    // even with the invalidator stubbed out.
    forgetSshSkillDiscoveryCapabilities('target-1')

    const upgraded = relayProvider({ ...EMPTY_RESULT, scannedAt: 777 })
    const result = await discoverSkillsOnTarget(sshTarget('target-1'), [], {
      sshProvider: upgraded.provider
    })
    expect(result.scannedAt).toBe(777)
  })

  it('probes relay capabilities once per connection, not once per scan', async () => {
    const { provider, requestHostRpc } = relayProvider()

    // `refresh` bypasses the result cache without the full invalidation that
    // clearSkillDiscoveryCaches performs, so this is two real scans.
    await discoverSkillsOnTarget(sshTarget('target-1'), [], { sshProvider: provider })
    await discoverSkillsOnTarget(sshTarget('target-1'), [], {
      sshProvider: provider,
      refresh: true
    })

    const probes = requestHostRpc.mock.calls.filter(([method]) => method === 'relay.status')
    expect(probes).toHaveLength(1)
  })

  it('rejects a malformed relay frame instead of trusting it', async () => {
    const { provider } = relayProvider({ ...EMPTY_RESULT, scannedAt: 'not-a-number' })

    await expect(
      discoverSkillsOnTarget(sshTarget('target-1'), [], { sshProvider: provider })
    ).rejects.toThrow()
  })
})
