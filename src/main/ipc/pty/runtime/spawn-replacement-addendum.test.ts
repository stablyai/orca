import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SpawnRegistration from '../pane/spawn-registration'
import type { Store } from '../../../persistence/loading-store/store'
import { TEST_LEAF_1 } from '../../../persistence/persistence-session-fixtures'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { installClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import { claudeListedPaneAccounts } from '../../../claude-accounts/claude-listed-pane-accounts'
import {
  getClaudePaneAccount,
  listClaudePaneAccounts,
  recordClaudePaneAccount
} from '../../../claude-accounts/claude-pane-account-registry'
import { clearProviderPtyState } from '../provider/state-cleanup'
import {
  paneSpawnReservationsByOwnerKey,
  rejectPaneSpawnReservation,
  resolvePaneSpawnReservation,
  makePaneSpawnReservationKey
} from '../pane/spawn-reservation'
import { makeReplacementDeps, replacementRouter } from './spawn-replacement-flow-fixture'
import { spawnPtyFromRuntimeController } from './spawn'
import type { RuntimePtySpawnState, RuntimePtySpawnArgs } from './spawn-state'

// Physical process execution is faked; preparation, replacement, durable swap and publication are real.
const physical = vi.hoisted(() => ({ stop: vi.fn(), spawn: vi.fn(), registrationExited: false }))
vi.mock('../ipc/renderer-kill', () => ({ stopReplacedPanePty: physical.stop }))
vi.mock('../spawn-begin', () => ({ beginPtySpawn: async () => null }))
vi.mock('../spawn-resume', () => ({ prepareSavedPtyResume: async () => async () => {} }))
vi.mock('../spawn-execute', () => ({ executePtySpawn: physical.spawn }))
vi.mock('../pane/spawn-registration', async (importOriginal) => {
  const actual = await importOriginal<typeof SpawnRegistration>()
  return {
    ...actual,
    registerPersistedPtySpawn: (...args: Parameters<typeof actual.registerPersistedPtySpawn>) =>
      physical.registrationExited
        ? Promise.reject(new Error('agent_session_exited_during_start'))
        : actual.registerPersistedPtySpawn(...args)
  }
})

const worktreeId = 'repo-local::/fixture/local'
const tabId = 'restart-tab'
const paneKey = makePaneKey(tabId, TEST_LEAF_1)
const reservationKey = makePaneSpawnReservationKey(worktreeId, null, paneKey)!
let root: string
let bound: string | undefined
let router: ReturnType<typeof replacementRouter>
let info: ReturnType<typeof vi.spyOn>
const persistPtyBinding: Store['persistPtyBinding'] = async (input) => {
  const binding = typeof input === 'function' ? input() : input
  if (!binding) {
    return false
  }
  bound = binding.ptyId
  return true
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the store ports read by the real replacement, preparation and commit paths exercised below.
const store = {
  getWorkspaceSession: () => ({
    tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId }] },
    terminalLayoutsByTabId: { [tabId]: { ptyIdsByLeafId: { [TEST_LEAF_1]: bound } } },
    terminalPtyIncarnationsByPaneKey: {}
  }),
  persistPtyBinding,
  retirePtyBinding: async ({ ptyId }: { ptyId: string }) => {
    if (bound !== ptyId) {
      return false
    }
    bound = undefined
    return true
  }
} as unknown as Store

function spawn(overrides: Partial<RuntimePtySpawnArgs> = {}) {
  const deps = makeReplacementDeps()
  deps.store = store
  const getSettings = deps.getSettings!
  deps.getSettings = () => ({ ...getSettings()!, activeClaudeManagedAccountId: 'a' })
  deps.prepareClaudeAuth = () => router.prepareLaunch()
  deps.adoptStablePane = async (args) => {
    const result = await args.spawnFresh!({ mustExist: false })
    resolvePaneSpawnReservation(reservationKey, args.reservation, result)
    return null
  }
  return spawnPtyFromRuntimeController(deps, {
    cols: 80,
    rows: 24,
    cwd: root,
    worktreeId,
    connectionId: null,
    tabId,
    leafId: TEST_LEAF_1,
    command: 'claude --resume s1',
    replacesPtyId: 'old',
    persistHostSessionBinding: true,
    claudeAccountId: 'b',
    env: { KEEP: '1' },
    ...overrides
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-replacement-flow-'))
  bound = 'old'
  physical.registrationExited = false
  router = replacementRouter(root)
  installClaudeProfileRouter(router)
  info = vi.spyOn(console, 'info').mockImplementation(() => {})
  recordClaudePaneAccount({
    ptyId: 'old',
    paneKey,
    accountId: 'a',
    configDir: '/a',
    launchedAt: 1,
    pinned: false,
    source: 'spawn'
  })
  physical.stop.mockImplementation(async () => {
    clearProviderPtyState('old')
  })
  physical.spawn.mockImplementation(async (ctx: RuntimePtySpawnState) => {
    ctx.result = { id: 'new', incarnationId: 'new-incarnation' }
  })
})

afterEach(() => {
  for (const [key, reservation] of paneSpawnReservationsByOwnerKey) {
    rejectPaneSpawnReservation(key, reservation, new Error('test teardown'))
  }
  clearProviderPtyState('old')
  clearProviderPtyState('new')
  installClaudeProfileRouter(undefined)
  vi.restoreAllMocks()
  vi.resetAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('runtime replacement addendum', () => {
  it('(k) launches on the chosen account and replaces the registry record after the swap', async () => {
    await expect(spawn()).resolves.toMatchObject({ id: 'new' })
    const ctx: RuntimePtySpawnState = physical.spawn.mock.calls[0][0]
    const home = join(root, 'data', 'claude-profiles', 'b', 'home')
    expect(ctx.spawnOptions.env).toMatchObject({ KEEP: '1', CLAUDE_CONFIG_DIR: home })
    expect(getClaudePaneAccount('new')).toMatchObject({
      accountId: 'b',
      configDir: home,
      pinned: false,
      paneKey,
      source: 'spawn'
    })
    expect(
      claudeListedPaneAccounts(
        [
          { id: 'a', email: 'a@example.test' },
          { id: 'b', email: 'b@example.test' }
        ],
        listClaudePaneAccounts()
      ).assignedSessions
    ).toEqual([
      { accountId: 'a', count: 0 },
      { accountId: 'b', count: 1 }
    ])
    expect(getClaudePaneAccount('old')).toBeNull()
    expect(bound).toBe('new')
    expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
  })

  it('records covered named B instead of selected A, while unpinned launches keep A', async () => {
    await router.prepareLaunchFor('a')
    mkdirSync(router.accountHome('a'), { recursive: true })
    writeFileSync(
      join(router.accountHome('a'), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } })
    )
    mkdirSync(join(root, 'personal'), { recursive: true })
    writeFileSync(
      join(root, 'personal', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@example.test' } })
    )
    await expect(router.prepareLaunchFor('b')).resolves.toMatchObject({ provenance: 'system' })
    await spawn()
    expect(getClaudePaneAccount('new')).toMatchObject({
      accountId: 'b',
      configDir: join(root, 'personal', '.claude'),
      pinned: false
    })
    bound = 'old'
    await spawn({ claudeAccountId: undefined })
    expect(getClaudePaneAccount('new')).toMatchObject({
      accountId: 'a',
      pinned: false,
      source: 'spawn'
    })
    expect(
      claudeListedPaneAccounts(
        [
          { id: 'a', email: 'a@example.test' },
          { id: 'b', email: 'b@example.test' }
        ],
        listClaudePaneAccounts()
      ).assignedSessions
    ).toEqual([
      { accountId: 'a', count: 1 },
      { accountId: 'b', count: 0 }
    ])
  })

  it('(l) refuses invalid host binding before stopping or reserving the old PTY', async () => {
    const old = getClaudePaneAccount('old')
    await expect(spawn({ persistHostSessionBinding: false })).rejects.toThrow(
      'replacesPtyId requires persistHostSessionBinding'
    )
    await expect(spawn({ leafId: 'invalid' })).rejects.toThrow(
      'Cannot persist runtime PTY binding without worktreeId, tabId, and leafId'
    )
    expect(physical.stop).not.toHaveBeenCalled()
    expect(physical.spawn).not.toHaveBeenCalled()
    expect(getClaudePaneAccount('old')).toBe(old)
    expect(getClaudePaneAccount('new')).toBeNull()
    expect(bound).toBe('old')
    expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
    expect(info).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown', 'claude_account_unknown', 'claudeAccountUnknown'],
    ['w', 'claude_account_wsl_unsupported', 'claudeAccountWslUnsupported']
  ])(
    '(n) preserves the old session on a typed account refusal: %s',
    async (accountId, message, reason) => {
      const old = getClaudePaneAccount('old')
      await expect(spawn({ claudeAccountId: accountId })).rejects.toMatchObject({ message, reason })
      expect(physical.stop).not.toHaveBeenCalled()
      expect(physical.spawn).not.toHaveBeenCalled()
      expect(getClaudePaneAccount('old')).toBe(old)
      expect(getClaudePaneAccount('new')).toBeNull()
      expect(bound).toBe('old')
      expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
      expect(info).not.toHaveBeenCalled()
    }
  )

  it('(n) ignores the account on a non-Claude command', async () => {
    const prepare = vi.spyOn(router, 'prepareLaunchFor')
    await expect(spawn({ command: 'bash', claudeAccountId: 'unknown' })).resolves.toMatchObject({
      id: 'new'
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(getClaudePaneAccount('new')).toBeNull()
    expect(info).not.toHaveBeenCalled()
  })

  it('(o) releases the stopped binding and reservation when execution fails', async () => {
    const error = Object.assign(new Error('spawn failed'), { code: 'EIO' })
    physical.spawn.mockRejectedValue(error)
    await expect(spawn()).rejects.toBe(error)
    expect(physical.stop).toHaveBeenCalledTimes(1)
    expect(bound).toBeUndefined()
    expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
    expect(getClaudePaneAccount('old')).toBeNull()
    expect(getClaudePaneAccount('new')).toBeNull()
    expect(info).not.toHaveBeenCalled()
  })

  it('(p) logs exactly once after the durable swap succeeds', async () => {
    info.mockImplementation(() => {
      expect(bound).toBe('new')
      expect(getClaudePaneAccount('new')?.accountId).toBe('b')
    })
    await spawn()
    expect(info).toHaveBeenCalledExactlyOnceWith(
      `[claude-session-mover] replaced pty old with new on account b (pane ${paneKey})`
    )
  })

  it('(p) does not log a swap rejected by registration after persistence', async () => {
    physical.registrationExited = true
    await expect(spawn()).rejects.toThrow('agent_session_exited_during_start')
    expect(bound).toBe('new')
    expect(info).not.toHaveBeenCalled()
    expect(getClaudePaneAccount('new')).toBeNull()
  })

  it('(p) never logs a refused durable swap', async () => {
    physical.spawn.mockImplementation(async (ctx: RuntimePtySpawnState) => {
      ctx.result = { id: 'new', incarnationId: 'new-incarnation' }
      bound = 'successor'
    })
    await expect(spawn()).rejects.toThrow('terminal_pane_owner_changed')
    expect(bound).toBe('successor')
    expect(info).not.toHaveBeenCalled()
    expect(getClaudePaneAccount('new')).toBeNull()
  })
})
