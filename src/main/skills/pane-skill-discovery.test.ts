import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult } from '../../shared/skills'
import type { SshSkillDiscoveryProvider } from '../providers/ssh-skill-discovery-provider'
import { SshSkillDiscoveryUnsupportedError } from '../providers/ssh-skill-discovery-provider'
import {
  registerSshSkillDiscoveryProvider,
  unregisterSshSkillDiscoveryProvider
} from '../providers/ssh-skill-discovery-dispatch'

const mocks = vi.hoisted(() => ({
  discoverSkillsOnTarget: vi.fn(),
  resolveSkillDiscoveryTarget: vi.fn()
}))

vi.mock('./skill-discovery-target', () => ({
  discoverSkillsOnTarget: mocks.discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget: mocks.resolveSkillDiscoveryTarget
}))

import { discoverPaneSkills } from './pane-skill-discovery'

const EMPTY_RESULT: SkillDiscoveryResult = { skills: [], sources: [], scannedAt: 1 }

function fakeProvider(discover: ReturnType<typeof vi.fn>): SshSkillDiscoveryProvider {
  return { getConnectionId: () => 'conn-1', discover } as unknown as SshSkillDiscoveryProvider
}

describe('discoverPaneSkills', () => {
  afterEach(() => {
    unregisterSshSkillDiscoveryProvider('conn-1')
    mocks.discoverSkillsOnTarget.mockReset()
    mocks.resolveSkillDiscoveryTarget.mockReset()
  })

  it('routes SSH panes to the connection-scoped provider with the derived cwd', async () => {
    const discover = vi.fn().mockResolvedValue(EMPTY_RESULT)
    registerSshSkillDiscoveryProvider('conn-1', fakeProvider(discover))
    const signal = new AbortController().signal

    const response = await discoverPaneSkills({
      worktreeId: 'wt-1',
      cwd: '/remote/repo',
      connectionId: 'conn-1',
      repos: [],
      signal
    })

    expect(response).toEqual({ status: 'ok', result: EMPTY_RESULT })
    expect(discover).toHaveBeenCalledWith('/remote/repo', { signal })
    expect(mocks.discoverSkillsOnTarget).not.toHaveBeenCalled()
  })

  it('reports an old relay as relay-upgrade-required, never an empty success', async () => {
    const discover = vi.fn().mockRejectedValue(new SshSkillDiscoveryUnsupportedError())
    registerSshSkillDiscoveryProvider('conn-1', fakeProvider(discover))

    await expect(
      discoverPaneSkills({
        worktreeId: 'wt-1',
        cwd: '/remote/repo',
        connectionId: 'conn-1',
        repos: []
      })
    ).resolves.toEqual({ status: 'relay-upgrade-required' })
  })

  it('fails a disconnected SSH pane instead of scanning local disk', async () => {
    await expect(
      discoverPaneSkills({
        worktreeId: 'wt-1',
        cwd: '/remote/repo',
        connectionId: 'conn-1',
        repos: []
      })
    ).rejects.toThrow('Remote connection dropped')
    expect(mocks.discoverSkillsOnTarget).not.toHaveBeenCalled()
  })

  it('keeps non-SSH panes on the existing local/WSL target resolution', async () => {
    const resolved = { kind: 'native-host', cwd: '/local/repo' }
    mocks.resolveSkillDiscoveryTarget.mockReturnValue(resolved)
    mocks.discoverSkillsOnTarget.mockResolvedValue(EMPTY_RESULT)
    const projectRuntime = { status: 'resolved' } as never
    const signal = new AbortController().signal

    const response = await discoverPaneSkills({
      worktreeId: 'wt-1',
      cwd: '/local/repo',
      projectRuntime,
      repos: [],
      signal
    })

    expect(response).toEqual({ status: 'ok', result: EMPTY_RESULT })
    expect(mocks.resolveSkillDiscoveryTarget).toHaveBeenCalledWith({
      cwd: '/local/repo',
      worktreeId: 'wt-1',
      projectRuntime
    })
    expect(mocks.discoverSkillsOnTarget).toHaveBeenCalledWith(resolved, [], signal)
  })
})
