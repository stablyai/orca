import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClaudeAccountRotationSettings } from '../../../shared/agent-accounts/claude/claude-account-rotation'
import type { RotationCheckDeps } from './claude-rotation-candidates'
import { checkRotationFolder } from './claude-rotation-check'
import type { ClaudeKeychainSlot, RotationSlotStore } from './claude-rotation-keychain'
import type { RotationFolder } from './claude-rotation-login-meta'
import type { RotationUsage } from './claude-rotation-policy'
import { RotationStateFiles } from './claude-rotation-state-files'
import { recoverInterruptedSwap } from './claude-rotation-recover'
import { placeLoginMeta, swapFolderLogins } from './claude-rotation-swap'
import { verifySwap } from './claude-rotation-verify'

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

function slotOf(id: Id): ClaudeKeychainSlot {
  return { claudeAiOauth: login(id), mcpOAuth: { server: `mcp-${id}` } }
}

/** A Map-backed keychain; `crashOnWrite` makes that write (1-based) throw like a killed process. */
function fakeKeychain(): RotationSlotStore & {
  slots: Map<string, ClaudeKeychainSlot>
  crashOnWrite: number
} {
  let writes = 0
  const store = {
    slots: new Map<string, ClaudeKeychainSlot>(),
    crashOnWrite: 0,
    read: async (service: string) => structuredClone(store.slots.get(service) ?? null),
    write: async (service: string, slot: ClaudeKeychainSlot) => {
      writes += 1
      if (writes === store.crashOnWrite) {
        throw new Error('interrupted')
      }
      store.slots.set(service, structuredClone(slot))
      return true
    },
    fits: () => true,
    remove: async (service: string) => {
      store.slots.delete(service)
    }
  }
  return store
}

function setup(ids: Id[]): {
  folders: Map<string, RotationFolder>
  keychain: ReturnType<typeof fakeKeychain>
  deps: RotationCheckDeps
  files: RotationStateFiles
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-claude-rotation-'))
  roots.push(root)
  const keychain = fakeKeychain()
  const folders = new Map<string, RotationFolder>()
  for (const id of ids) {
    const home = join(root, id, 'home')
    mkdirSync(home, { recursive: true })
    const stateFile = join(home, '.claude.json')
    writeFileSync(
      stateFile,
      JSON.stringify({
        oauthAccount: { accountUuid: `${ACCOUNT[id]}-0000`, emailAddress: `${id}@example.test` },
        projects: { [`/work/${id}`]: {} }
      })
    )
    folders.set(id, { accountId: id, home, service: `svc-${id}`, stateFile })
    keychain.slots.set(`svc-${id}`, slotOf(id))
  }
  const files = new RotationStateFiles(join(root, 'rotation'))
  const whoami = async (token: string): Promise<string | null> =>
    Object.entries(ACCOUNT).find(([id]) => token === `access-${id}`)?.[1] ?? null
  const deps: RotationCheckDeps = {
    slots: keychain,
    files,
    whoami,
    now: () => NOW,
    sleep: async () => {},
    fetchUsage: async () => ({ status: 'failed' }),
    readSessions: async () => new Map()
  }
  return { folders, keychain, deps, files }
}

function folder(folders: Map<string, RotationFolder>, id: Id): RotationFolder {
  const found = folders.get(id)
  if (!found) {
    throw new Error(`missing folder ${id}`)
  }
  return found
}

const request = {
  reason: 'test',
  kind: 'over' as const,
  fromAccount: ACCOUNT.a,
  toAccount: ACCOUNT.b
}

it('finishes or cancels a swap cut off mid-write without losing either login', async () => {
  // Crash on write 4 (the second folder): finish it from the backup copy.
  const cut = setup(['a', 'b'])
  cut.keychain.crashOnWrite = 4
  const a = folder(cut.folders, 'a')
  const b = folder(cut.folders, 'b')
  const first = await swapFolderLogins(a, b, request, cut.deps)
  expect(first.ok).toBe(false)
  expect((await cut.files.loadJournal())?.step).toBe('a_written')

  expect(await recoverInterruptedSwap(cut.deps)).toBe('finished')
  expect(cut.keychain.slots.get('svc-a')).toEqual({ ...slotOf('a'), claudeAiOauth: login('b') })
  expect(cut.keychain.slots.get('svc-b')).toEqual({ ...slotOf('b'), claudeAiOauth: login('a') })
  expect((await verifySwap(cut.deps, true))?.outcome).toBe('ok')
  expect(await cut.files.loadJournal()).toBeNull()
  expect([...cut.keychain.slots.keys()].sort()).toEqual(['svc-a', 'svc-b'])

  // Crash on write 3 (the first folder): nothing changed, so the journal just goes away.
  const early = setup(['a', 'b'])
  early.keychain.crashOnWrite = 3
  await swapFolderLogins(
    folder(early.folders, 'a'),
    folder(early.folders, 'b'),
    request,
    early.deps
  )
  expect(await recoverInterruptedSwap(early.deps)).toBe('nothing_written')
  expect(early.keychain.slots.get('svc-a')).toEqual(slotOf('a'))
  expect(early.keychain.slots.get('svc-b')).toEqual(slotOf('b'))
  expect(await early.files.loadJournal()).toBeNull()

  // Cut after the first write, then b refreshed its own login: the copy in a is spent, so a gets
  // its own login back and b keeps the refreshed one.
  const raced = setup(['a', 'b'])
  raced.keychain.crashOnWrite = 4
  await swapFolderLogins(
    folder(raced.folders, 'a'),
    folder(raced.folders, 'b'),
    request,
    raced.deps
  )
  const refreshedB = {
    ...slotOf('b'),
    claudeAiOauth: { ...login('b'), refreshToken: 'refresh-b2' }
  }
  raced.keychain.slots.set('svc-b', refreshedB)
  expect(await recoverInterruptedSwap(raced.deps)).toBe('cancelled')
  expect(raced.keychain.slots.get('svc-a')).toEqual(slotOf('a'))
  expect(raced.keychain.slots.get('svc-b')).toEqual(refreshedB)
  expect([...raced.keychain.slots.keys()].sort()).toEqual(['svc-a', 'svc-b'])
})

it('puts the old login of b back when the outgoing session writes its login back', async () => {
  const { folders, keychain, deps } = setup(['a', 'b'])
  const a = folder(folders, 'a')
  expect((await swapFolderLogins(a, folder(folders, 'b'), request, deps)).ok).toBe(true)
  // The session in a wrote its old login back as it was; no server answer is needed to see it.
  keychain.slots.set('svc-a', slotOf('a'))
  deps.whoami = async () => null
  expect((await verifySwap(deps, true))?.outcome).toBe('reverted')
  expect(keychain.slots.get('svc-b')).toEqual(slotOf('b'))
  expect(JSON.parse(readFileSync(a.stateFile, 'utf8')).oauthAccount.emailAddress).toBe(
    'a@example.test'
  )
})

it('blocks a new swap while an unreadable journal is on disk', async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b'])
  mkdirSync(files.dir, { recursive: true })
  writeFileSync(files.journalPath, '{"at": 1, "a"')
  const result = await swapFolderLogins(folder(folders, 'a'), folder(folders, 'b'), request, deps)
  expect(result).toEqual({ ok: false, detail: 'previous_swap_unverified' })
  expect(keychain.slots.get('svc-a')).toEqual(slotOf('a'))
})

it('sets account details and records once, however often the step repeats', async () => {
  const { folders, deps, files } = setup(['a', 'b'])
  const records = new Map([
    ['a', 'record-a'],
    ['b', 'record-b']
  ])
  deps.records = {
    fingerprint: (id) => records.get(id) ?? null,
    exchange: (x, y) => {
      const first = records.get(x) ?? ''
      records.set(x, records.get(y) ?? '')
      records.set(y, first)
    }
  }
  const a = folder(folders, 'a')
  const b = folder(folders, 'b')
  // An abandoned Claude lock (untouched for years) does not hold the swap up.
  const stale = `${a.home}.lock`
  mkdirSync(stale)
  const old = new Date('2020-01-01T00:00:00Z')
  utimesSync(stale, old, old)
  const swapped = await swapFolderLogins(a, b, request, deps)
  expect(swapped.ok).toBe(true)
  const journal = await files.loadJournal()
  if (!journal) {
    throw new Error('missing journal')
  }
  // As after a quit right before the journal noted the step: it runs again.
  expect(await placeLoginMeta(journal, 'swapped', deps)).toBe('ok')
  const email = (path: string): string =>
    JSON.parse(readFileSync(path, 'utf8')).oauthAccount.emailAddress
  expect([email(a.stateFile), email(b.stateFile)]).toEqual(['b@example.test', 'a@example.test'])
  expect([records.get('a'), records.get('b')]).toEqual(['record-b', 'record-a'])
})

it('moves only claudeAiOauth and oauthAccount between folders', async () => {
  const { folders, keychain, deps } = setup(['a', 'b'])
  const a = folder(folders, 'a')
  const b = folder(folders, 'b')
  expect((await swapFolderLogins(a, b, request, deps)).ok).toBe(true)
  expect(keychain.slots.get('svc-a')).toEqual({
    claudeAiOauth: login('b'),
    mcpOAuth: { server: 'mcp-a' }
  })
  expect(keychain.slots.get('svc-b')).toEqual({
    claudeAiOauth: login('a'),
    mcpOAuth: { server: 'mcp-b' }
  })
  const stateA = JSON.parse(readFileSync(a.stateFile, 'utf8'))
  expect(stateA.oauthAccount.emailAddress).toBe('b@example.test')
  expect(stateA.projects).toEqual({ '/work/a': {} })
})

const settings: ClaudeAccountRotationSettings = {
  enabled: true,
  fiveHourPercent: 90,
  weeklyPercent: 97,
  order: 'prefer',
  preferredAccounts: [ACCOUNT.b]
}

function usage(five: number): RotationUsage {
  return {
    five,
    fiveResetsAt: NOW + 3_600_000,
    week: 10,
    weekResetsAt: null,
    weekNext: 0,
    weekNextResetsAt: null,
    weekAllResetsAt: null
  }
}

it('never takes the login of a folder with running Claude sessions', async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b', 'c'])
  deps.fetchUsage = async (token) => ({ status: 'ok', usage: usage(token === 'access-a' ? 95 : 5) })
  const target = folder(folders, 'a')
  const all = [...folders.values()]
  const busyB = new Map([[folder(folders, 'b').home, 1]])
  deps.readSessions = async () => busyB

  // b is preferred but busy, so c is the one swapped in.
  const swapped = await checkRotationFolder({
    target,
    folders: all,
    sessions: busyB,
    state: await files.loadState(),
    settings,
    deps
  })
  expect(swapped?.note).toBe('swapped')
  expect(keychain.slots.get('svc-a')?.claudeAiOauth).toEqual(login('c'))
  expect(keychain.slots.get('svc-b')).toEqual(slotOf('b'))

  // A login that changed after the check is not swapped on the strength of that check.
  const moved = setup(['a', 'b'])
  const guard = { aRefresh: 'stale', bRefresh: 'stale', beforeWrite: async () => null }
  const changed = await swapFolderLogins(
    folder(moved.folders, 'a'),
    folder(moved.folders, 'b'),
    request,
    moved.deps,
    guard
  )
  expect(changed).toEqual({ ok: false, detail: 'login_changed' })

  // A session that starts in the chosen folder during the usage reads stops the swap.
  const late = setup(['a', 'b'])
  late.deps.fetchUsage = deps.fetchUsage
  late.deps.readSessions = async () => new Map([[folder(late.folders, 'b').home, 1]])
  const blocked = await checkRotationFolder({
    target: folder(late.folders, 'a'),
    folders: [...late.folders.values()],
    sessions: new Map(),
    state: await late.files.loadState(),
    settings,
    deps: late.deps
  })
  expect(blocked?.note).toBe('candidate_busy')
  expect(late.keychain.slots.get('svc-a')).toEqual(slotOf('a'))

  // Sessions that cannot be counted count as running everywhere.
  const unknown = setup(['a', 'b'])
  unknown.deps.fetchUsage = deps.fetchUsage
  const result = await checkRotationFolder({
    target: folder(unknown.folders, 'a'),
    folders: [...unknown.folders.values()],
    sessions: null,
    state: await unknown.files.loadState(),
    settings,
    deps: unknown.deps
  })
  expect(result?.note).toBe('over_no_candidate')
  expect(unknown.keychain.slots.get('svc-b')).toEqual(slotOf('b'))
})
