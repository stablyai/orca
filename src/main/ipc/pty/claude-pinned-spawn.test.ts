import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth-service'

const mocks = vi.hoisted(() => ({
  markClaudePtySpawned: vi.fn(),
  markPinnedClaudePtySpawned: vi.fn(),
  releaseClaudePinnedAccountReservation: vi.fn()
}))

vi.mock('../../claude-accounts/live-pty-gate', () => ({
  markClaudePtySpawned: mocks.markClaudePtySpawned
}))
vi.mock('../../claude-accounts/claude-pinned-pty-registry', () => ({
  markPinnedClaudePtySpawned: mocks.markPinnedClaudePtySpawned,
  releaseClaudePinnedAccountReservation: mocks.releaseClaudePinnedAccountReservation
}))

import {
  isFreshClaudeLaunch,
  preparePinnableClaudeAuth,
  markClaudePtySpawnedForAuth,
  releasePinnedClaudeReservation
} from './claude-pinned-spawn'

beforeEach(() => {
  vi.clearAllMocks()
})

function makeAuth(
  overrides: Partial<ClaudeRuntimeAuthPreparation> = {}
): ClaudeRuntimeAuthPreparation {
  return {
    configDir: '/tmp/claude',
    envPatch: {},
    stripAuthEnv: false,
    provenance: 'managed:acct-1',
    ...overrides
  }
}

describe('isFreshClaudeLaunch', () => {
  it('recognizes a launch by its command', () => {
    expect(isFreshClaudeLaunch({ preAdoptedStablePane: false, command: 'claude' }, undefined)).toBe(
      true
    )
  })

  it('rejects an adopted stable pane or SSH connection', () => {
    expect(isFreshClaudeLaunch({ preAdoptedStablePane: true, command: 'claude' }, undefined)).toBe(
      false
    )
    expect(
      isFreshClaudeLaunch(
        { preAdoptedStablePane: false, connectionId: 'ssh-1', command: 'claude' },
        undefined
      )
    ).toBe(false)
  })

  it('trusts the launch agent for a pinned launch without a matching command', () => {
    expect(
      isFreshClaudeLaunch({ preAdoptedStablePane: false, launchAgent: 'claude' }, 'acct-1')
    ).toBe(true)
  })

  it('does not trust the launch agent without a pinned account or the trust option', () => {
    expect(
      isFreshClaudeLaunch({ preAdoptedStablePane: false, launchAgent: 'claude' }, undefined)
    ).toBe(false)
  })

  it('trusts the launch agent when options.trustLaunchAgent is set, even without a pinned account', () => {
    expect(
      isFreshClaudeLaunch({ preAdoptedStablePane: false, launchAgent: 'claude' }, undefined, {
        trustLaunchAgent: true
      })
    ).toBe(true)
  })
})

describe('preparePinnableClaudeAuth', () => {
  it('returns null when there is no prepare function and no pinned account', async () => {
    await expect(preparePinnableClaudeAuth(undefined, {}, undefined)).resolves.toBeNull()
  })

  it('throws when a pinned launch has no prepare function', async () => {
    await expect(preparePinnableClaudeAuth(undefined, {}, 'acct-1')).rejects.toThrow(
      'This Orca runtime cannot prepare Claude accounts for pinned launches.'
    )
  })

  it('calls prepare without options when there is no pinned account', async () => {
    const auth = makeAuth()
    const prepare = vi.fn().mockResolvedValue(auth)
    await expect(preparePinnableClaudeAuth(prepare, {}, undefined)).resolves.toBe(auth)
    expect(prepare).toHaveBeenCalledWith({})
  })

  it('accepts a pinned-provenance result for the requested account', async () => {
    const auth = makeAuth({ provenance: 'managed:acct-1:pinned', pinnedAccountId: 'acct-1' })
    const prepare = vi.fn().mockResolvedValue(auth)
    await expect(preparePinnableClaudeAuth(prepare, {}, 'acct-1')).resolves.toBe(auth)
    expect(prepare).toHaveBeenCalledWith({}, { accountId: 'acct-1' })
  })

  it('rejects a result whose provenance is for a different account', async () => {
    const prepare = vi.fn().mockResolvedValue(makeAuth({ provenance: 'managed:acct-2' }))
    await expect(preparePinnableClaudeAuth(prepare, {}, 'acct-1')).rejects.toThrow(
      'Orca could not prepare the requested Claude account for this launch. Check `orca account list` and retry.'
    )
  })
})

describe('markClaudePtySpawnedForAuth', () => {
  it('marks a pinned PTY against its pinned account', () => {
    markClaudePtySpawnedForAuth('pty-1', makeAuth({ pinnedAccountId: 'acct-1' }))
    expect(mocks.markPinnedClaudePtySpawned).toHaveBeenCalledWith('pty-1', 'acct-1')
    expect(mocks.markClaudePtySpawned).not.toHaveBeenCalled()
  })

  it('marks a non-pinned PTY against the live gate with its provenance', () => {
    markClaudePtySpawnedForAuth('pty-2', makeAuth({ provenance: 'managed:acct-1' }))
    expect(mocks.markClaudePtySpawned).toHaveBeenCalledWith('pty-2', 'managed:acct-1')
    expect(mocks.markPinnedClaudePtySpawned).not.toHaveBeenCalled()
  })
})

describe('releasePinnedClaudeReservation', () => {
  it('releases a pinned reservation', () => {
    releasePinnedClaudeReservation(makeAuth({ pinnedAccountId: 'acct-1' }))
    expect(mocks.releaseClaudePinnedAccountReservation).toHaveBeenCalledWith('acct-1')
  })

  it('does nothing for an unpinned or missing auth', () => {
    releasePinnedClaudeReservation(makeAuth())
    releasePinnedClaudeReservation(null)
    expect(mocks.releaseClaudePinnedAccountReservation).not.toHaveBeenCalled()
  })
})
