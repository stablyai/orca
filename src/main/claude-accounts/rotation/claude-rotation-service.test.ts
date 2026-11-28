import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/orca-profiles/constants'
import type { RotationCheckDeps } from './claude-rotation-candidates'
import type { ClaudeKeychainSlot, RotationSlotStore } from './claude-rotation-keychain'
import type { RotationFolder } from './claude-rotation-login-meta'
import { ROTATION_TIMING } from './claude-rotation-policy'
import { ClaudeAccountRotationService } from './claude-rotation-service'
import { swapFolderLogins } from './claude-rotation-swap'

// Every check runs on an in-memory keychain; touching the real one fails the test.
vi.mock('../../macos-keychain/generic-password', async (importOriginal) => {
  const refuse = (): never => {
    throw new Error('tests must not reach the real keychain')
  }
  return {
    ...(await importOriginal<object>()),
    readKeychainPassword: refuse,
    writeKeychainPassword: refuse,
    deleteKeychainPassword: refuse
  }
})

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const NOW = 1_800_000_000_000
const ACCOUNT = { a: 'aaaaaaaa', b: 'bbbbbbbb', c: 'cccccccc' } as const
type Id = keyof typeof ACCOUNT

function login(id: Id): Record<string, unknown> {
  return {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: NOW + 3_600_000,
    scopes: ['user:inference']
  }
}

/** A swap cut off at its second write, as a quit would leave it, seen by the service a minute on. */
async function cutOffSwap(): Promise<{
  service: ClaudeAccountRotationService
  slots: Map<string, ClaudeKeychainSlot>
  notify: ReturnType<typeof vi.fn>
  rateLimits: {
    evictInactiveClaudeCache: ReturnType<typeof vi.fn>
    refreshForClaudeAccountChange: ReturnType<typeof vi.fn>
  }
}> {
  const root = mkdtempSync(join(tmpdir(), 'orca-claude-rotation-service-'))
  roots.push(root)
  const slots = new Map<string, ClaudeKeychainSlot>()
  let writes = 0
  const keychain: RotationSlotStore = {
    read: async (service) => structuredClone(slots.get(service) ?? null),
    write: async (service, slot) => {
      writes += 1
      if (writes === 4) {
        throw new Error('interrupted')
      }
      slots.set(service, structuredClone(slot))
      return true
    },
    fits: () => true,
    remove: async (service) => {
      slots.delete(service)
    }
  }
  const folders: RotationFolder[] = (['a', 'b'] as const).map((id) => {
    const home = join(root, id, 'home')
    mkdirSync(home, { recursive: true })
    const stateFile = join(home, '.claude.json')
    writeFileSync(
      stateFile,
      JSON.stringify({ oauthAccount: { accountUuid: `${ACCOUNT[id]}-0000` } })
    )
    slots.set(`svc-${id}`, { claudeAiOauth: login(id) })
    return { accountId: id, home, service: `svc-${id}`, stateFile }
  })
  const deps: Partial<RotationCheckDeps> = {
    slots: keychain,
    whoami: async (token) =>
      Object.entries(ACCOUNT).find(([id]) => token === `access-${id}`)?.[1] ?? null,
    now: () => NOW + 60_000,
    sleep: async () => {},
    fetchUsage: async () => ({ status: 'failed' }),
    readSessions: async () => new Map()
  }
  const settings = getDefaultSettings(root)
  const notify = vi.fn()
  const rateLimits = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
  }
  const service = new ClaudeAccountRotationService({
    store: {
      getSettings: () => settings,
      updateSettingsAndFlush: async () => settings,
      onSettingsChanged: () => () => {}
    },
    router: {
      accountHome: (id) => join(root, id, 'home'),
      coveredBySystemDefault: () => false,
      userHome: root
    },
    rateLimits,
    dataRoot: root,
    notify,
    platform: 'darwin',
    deps
  })
  const request = {
    reason: 'test',
    kind: 'over' as const,
    fromAccount: ACCOUNT.a,
    toAccount: ACCOUNT.b
  }
  const swapDeps = {
    slots: keychain,
    files: service.files,
    whoami: async () => null,
    now: () => NOW
  }
  const [a, b] = folders
  expect((await swapFolderLogins(a, b, request, swapDeps)).ok).toBe(false)
  expect((await service.files.loadJournal())?.step).toBe('a_written')
  return { service, slots, notify, rateLimits }
}

it('refreshes usage after it finishes a cut-off swap and the check confirms it', async () => {
  const { service, slots, notify, rateLimits } = await cutOffSwap()
  await service.runCycle()
  expect(await service.files.loadJournal()).toBeNull()
  expect(slots.get('svc-a')?.claudeAiOauth).toEqual(login('b'))
  expect(slots.get('svc-b')?.claudeAiOauth).toEqual(login('a'))
  expect(rateLimits.evictInactiveClaudeCache.mock.calls).toEqual([['a'], ['b']])
  expect(rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
})

it('tells the user once and pauses when a cut-off swap left a folder with a third account', async () => {
  const { service, slots, notify } = await cutOffSwap()
  slots.set('svc-b', { claudeAiOauth: login('c') })
  expect(await service.runCycle()).toBe(ROTATION_TIMING.idleMaxMs)
  expect(await service.runCycle()).toBe(ROTATION_TIMING.idleMaxMs)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify.mock.calls[0]?.[0].body).toContain('no login or one for another account')
  const status = await service.getStatus()
  expect(status.pendingSwitch).toBe(true)
  expect(status.switchNeedsRepair).toBe(true)
  expect(await service.files.loadJournal()).not.toBeNull()
})
