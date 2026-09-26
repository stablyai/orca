import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _internals as pinnedRegistryInternals,
  countClaudePinnedAccountUsers,
  hasLivePinnedClaudePtys,
  reserveClaudePinnedAccount
} from '../../../claude-accounts/claude-pinned-pty-registry'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcDeps } from './spawn-types'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('./spawn-begin', () => ({ beginPtyIpcSpawn: vi.fn(async () => undefined) }))
vi.mock('./spawn-preflight', () => ({
  preparePtyIpcSpawnPreflight: vi.fn(async (ctx: PtyIpcSpawnState) => {
    // Mirrors auth preparation: a pinned preparation holds a reservation for the spawn to release.
    reserveClaudePinnedAccount('acct-1')
    ctx.isClaudeLaunch = true
    ctx.claudeAuth = {
      configDir: '/managed/acct-1',
      envPatch: {},
      stripAuthEnv: true,
      provenance: 'managed:acct-1:pinned',
      pinnedAccountId: 'acct-1'
    }
  })
}))
vi.mock('./spawn-env', () => ({ assemblePtyIpcSpawnEnv: vi.fn(async () => {}) }))
vi.mock('./spawn-options', () => ({ buildPtyIpcSpawnOptions: vi.fn(async () => undefined) }))
vi.mock('./spawn-execute', () => ({
  executePtyIpcSpawn: vi.fn(async (ctx: PtyIpcSpawnState) => {
    if (ctx.args.command !== 'claude --spawns') {
      throw new Error('provider spawn failed')
    }
    ctx.stablePaneOwner = null
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: commit reads only id and optional result fields, all absent here.
    ctx.result = { id: 'pty-pinned' } as PtyIpcSpawnState['result']
  })
}))
vi.mock('./spawn-commit-persist', () => ({
  persistPtyIpcSpawnCommit: vi.fn(async () => ({
    rendererPreSignaled: true,
    rendererAlreadyRegistered: false,
    committedSize: undefined
  }))
}))

describe('renderer pty spawn run: pinned Claude reservation', () => {
  afterEach(() => {
    pinnedRegistryInternals.reset()
  })

  it('releases the pinned reservation when a later stage fails', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every stage that reads deps is mocked; the run's own catch/finally only touch the stubbed members.
    const deps = {
      transitionSpawnHiddenRendererPtyDeliveryState: vi.fn()
    } as unknown as PtySpawnIpcDeps

    await expect(runPtyIpcSpawn(deps, { cols: 80, rows: 24, command: 'claude' })).rejects.toThrow(
      'provider spawn failed'
    )
    expect(countClaudePinnedAccountUsers('acct-1')).toBe(0)
  })

  it('keeps a live pinned PTY registered when a post-spawn commit step throws', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: commit reaches only runtime.registerPty before the injected throw; every other stage is mocked.
    const deps = {
      transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
      runtime: {
        registerPty: vi.fn(() => {
          throw new Error('registerPty failed')
        })
      }
    } as unknown as PtySpawnIpcDeps

    await expect(
      runPtyIpcSpawn(deps, { cols: 80, rows: 24, command: 'claude --spawns', worktreeId: 'wt-1' })
    ).rejects.toThrow('registerPty failed')
    expect(hasLivePinnedClaudePtys('acct-1')).toBe(true)
    expect(countClaudePinnedAccountUsers('acct-1')).toBe(1)
  })
})
