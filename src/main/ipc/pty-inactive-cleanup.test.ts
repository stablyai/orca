import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import {
  inspectPtyInactiveCleanupTargets,
  type PtyInactiveCleanupProvider
} from './pty-inactive-cleanup'

function makeProvider(args: {
  foreground: string | null
  children: boolean
  listedIds: string[]
  agentOwnedIds?: string[]
  authoritativeOwnerListings?: boolean
}): PtyInactiveCleanupProvider {
  return {
    listProcesses: vi.fn(async () =>
      args.listedIds.map((id) => ({
        id,
        cwd: '/tmp',
        title: id,
        ...(args.agentOwnedIds?.includes(id)
          ? { agentSessionOwners: [{} as AgentSessionOwnerBinding] }
          : {})
      }))
    ),
    hasChildProcesses: vi.fn(async () => args.children),
    confirmForegroundProcess: vi.fn(async () => args.foreground),
    providesAgentSessionOwnerListings: vi.fn(() => args.authoritativeOwnerListings !== false)
  }
}

describe('inspectPtyInactiveCleanupTargets', () => {
  it.each([
    ['zsh', false, 'inactive'],
    ['bash', false, 'inactive'],
    ['fish', false, 'inactive'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', false, 'inactive'],
    ['C:\\Windows\\System32\\cmd.exe', false, 'inactive'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', false, 'inactive'],
    ['codex', false, 'active'],
    ['claude', false, 'active'],
    ['bash', true, 'active']
  ] as const)('classifies %s with children=%s as %s', async (foreground, children, safety) => {
    const provider = makeProvider({ foreground, children, listedIds: ['pty-1'] })

    await expect(inspectPtyInactiveCleanupTargets([{ id: 'pty-1', provider }])).resolves.toEqual([
      { id: 'pty-1', safety }
    ])
  })

  it('protects null foreground, missing providers, and rejected inspection as unknown', async () => {
    const nullForeground = makeProvider({
      foreground: null,
      children: false,
      listedIds: ['null-foreground']
    })
    const rejected = makeProvider({
      foreground: 'zsh',
      children: false,
      listedIds: ['rejected']
    })
    rejected.hasChildProcesses = vi.fn().mockRejectedValue(new Error('offline'))

    await expect(
      inspectPtyInactiveCleanupTargets([
        { id: 'null-foreground', provider: nullForeground },
        { id: 'rejected', provider: rejected },
        { id: 'missing-provider', provider: null }
      ])
    ).resolves.toEqual([
      { id: 'null-foreground', safety: 'unknown' },
      { id: 'rejected', safety: 'unknown' },
      { id: 'missing-provider', safety: 'unknown' }
    ])
  })

  it('protects claimed sessions and providers without authoritative owner listings', async () => {
    const claimed = makeProvider({
      foreground: 'zsh',
      children: false,
      listedIds: ['claimed'],
      agentOwnedIds: ['claimed']
    })
    const legacy = makeProvider({
      foreground: 'zsh',
      children: false,
      listedIds: ['legacy'],
      authoritativeOwnerListings: false
    })

    await expect(
      inspectPtyInactiveCleanupTargets([
        { id: 'claimed', provider: claimed },
        { id: 'legacy', provider: legacy }
      ])
    ).resolves.toEqual([
      { id: 'claimed', safety: 'active' },
      { id: 'legacy', safety: 'unknown' }
    ])
    expect(claimed.hasChildProcesses).not.toHaveBeenCalled()
    expect(legacy.hasChildProcesses).not.toHaveBeenCalled()
  })

  it('accepts positive activity evidence when the other inspection is unavailable', async () => {
    const childEvidence = makeProvider({
      foreground: null,
      children: true,
      listedIds: ['child-active']
    })
    childEvidence.confirmForegroundProcess = vi.fn().mockRejectedValue(new Error('unavailable'))
    const foregroundEvidence = makeProvider({
      foreground: 'codex',
      children: false,
      listedIds: ['foreground-active']
    })
    foregroundEvidence.hasChildProcesses = vi.fn().mockRejectedValue(new Error('unavailable'))

    await expect(
      inspectPtyInactiveCleanupTargets([
        { id: 'child-active', provider: childEvidence },
        { id: 'foreground-active', provider: foregroundEvidence }
      ])
    ).resolves.toEqual([
      { id: 'child-active', safety: 'active' },
      { id: 'foreground-active', safety: 'active' }
    ])
  })

  it('lists once per provider and marks absent ids gone', async () => {
    const provider = makeProvider({ foreground: 'zsh', children: false, listedIds: ['present'] })

    await expect(
      inspectPtyInactiveCleanupTargets([
        { id: 'present', provider },
        { id: 'gone', provider }
      ])
    ).resolves.toEqual([
      { id: 'present', safety: 'inactive' },
      { id: 'gone', safety: 'gone' }
    ])
    expect(provider.listProcesses).toHaveBeenCalledOnce()
    expect(provider.hasChildProcesses).toHaveBeenCalledOnce()
    expect(provider.confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it('protects every target when provider inventory fails', async () => {
    const provider = makeProvider({ foreground: 'zsh', children: false, listedIds: ['a', 'b'] })
    provider.listProcesses = vi.fn().mockRejectedValue(new Error('disconnected'))

    await expect(
      inspectPtyInactiveCleanupTargets([
        { id: 'a', provider },
        { id: 'b', provider }
      ])
    ).resolves.toEqual([
      { id: 'a', safety: 'unknown' },
      { id: 'b', safety: 'unknown' }
    ])
    expect(provider.hasChildProcesses).not.toHaveBeenCalled()
    expect(provider.confirmForegroundProcess).not.toHaveBeenCalled()
  })
})
