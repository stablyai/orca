import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from '../../../daemon/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../../../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../../../daemon/degraded-daemon-pty-provider'
import { TerminalSessionOwnerUnverifiedError } from '../../../daemon/daemon-errors'
import { PROTOCOL_VERSION } from '../../../daemon/daemon-protocol-version'
import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session-host-authority'
import { isProviderAgentSessionOwnerLive, isProviderPtyLive, verifyPtyStopped } from './liveness'
import { ptyIncarnationById } from './ownership-state'

const targetId = 'target@@terminal'
const unrelatedId = 'other@@duplicate'
const owner: AgentSessionOwnerBinding = {
  claim: {
    digestVersion: 1,
    keyId: 'key',
    identityDigest: 'identity',
    worktreeScopeDigest: 'scope',
    agent: 'codex'
  },
  generation: 'generation',
  phase: 'live',
  ptyId: targetId,
  surface: { worktreeId: 'target', tabId: 'tab', leafId: 'leaf', terminalHandle: 'handle' }
}

function setup(kind: 'router' | 'degraded') {
  const currentSessions = [targetId, unrelatedId]
  const legacySessions = [unrelatedId]
  const current = createAdapter('current', currentSessions, undefined, PROTOCOL_VERSION)
  const legacy = createAdapter('legacy', legacySessions, undefined, PROTOCOL_VERSION)
  const provider =
    kind === 'router'
      ? new DaemonPtyRouter({ current, legacy: [legacy] })
      : new DegradedDaemonPtyProvider({
          current,
          legacy: [legacy],
          fallback: createAdapter('fallback')
        })
  return { provider, current, legacy, currentSessions, legacySessions }
}

describe.each(['router', 'degraded'] as const)('%s targeted liveness inventory', (kind) => {
  afterEach(() => ptyIncarnationById.delete(targetId))

  it('observes the target before and after shutdown despite an unrelated duplicate', async () => {
    const { provider, currentSessions, legacySessions } = setup(kind)
    await expect(isProviderPtyLive(provider, targetId)).resolves.toBe(true)
    await provider.shutdown(targetId, { immediate: true })

    await expect(
      verifyPtyStopped(provider, targetId, { deadlineMs: Date.now() + 10_000 })
    ).resolves.toBe(true)
    expect(currentSessions).toEqual([unrelatedId])
    expect(legacySessions).toEqual([unrelatedId])
    await expect(provider.listProcesses()).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
  })

  it('does not prove a live or ambiguously owned target stopped', async () => {
    const { provider, legacySessions } = setup(kind)
    await expect(verifyPtyStopped(provider, targetId, undefined)).resolves.toBe(false)
    legacySessions.push(targetId)

    await expect(isProviderPtyLive(provider, targetId)).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    await expect(verifyPtyStopped(provider, targetId, undefined)).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
  })

  it('cannot prove target absence from an incomplete host inventory', async () => {
    const { provider, currentSessions, legacy } = setup(kind)
    currentSessions.splice(currentSessions.indexOf(targetId), 1)
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('legacy unavailable'))

    await expect(isProviderPtyLive(provider, targetId)).rejects.toThrow('legacy unavailable')
    await expect(verifyPtyStopped(provider, targetId, undefined)).rejects.toThrow(
      'legacy unavailable'
    )
    await expect(isProviderAgentSessionOwnerLive(provider, owner)).rejects.toThrow(
      'legacy unavailable'
    )
  })

  it('checks the target owner claim without requiring unrelated route authority', async () => {
    const { provider, current, currentSessions } = setup(kind)
    let generation = owner.generation
    vi.mocked(current.listProcesses).mockImplementation(async () =>
      currentSessions.map((id) => ({
        id,
        incarnationId: 'live',
        cwd: '',
        title: 'shell',
        ...(id === targetId ? { agentSessionOwners: [{ ...owner, generation }] } : {})
      }))
    )

    await expect(isProviderAgentSessionOwnerLive(provider, owner)).resolves.toBe(true)
    generation = 'replacement'
    await expect(isProviderAgentSessionOwnerLive(provider, owner)).resolves.toBe(false)
  })

  it('requires the exact target incarnation when owner listings are unavailable', async () => {
    const { provider, current, currentSessions } = setup(kind)
    let incarnationId = 'live'
    vi.spyOn(current, 'providesAgentSessionOwnerListings').mockReturnValue(false)
    vi.mocked(current.listProcesses).mockImplementation(async () =>
      currentSessions.map((id) => ({ id, incarnationId, cwd: '', title: 'shell' }))
    )
    ptyIncarnationById.set(targetId, incarnationId)
    await expect(isProviderAgentSessionOwnerLive(provider, owner)).resolves.toBe(true)

    incarnationId = 'replacement'
    await expect(isProviderAgentSessionOwnerLive(provider, owner)).resolves.toBe(false)
    ptyIncarnationById.delete(targetId)
    await expect(isProviderAgentSessionOwnerLive(provider, owner)).resolves.toBe(false)
  })
})
