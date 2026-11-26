import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClaudeAccountRotationSettings } from '../../../shared/agent-accounts/claude/claude-account-rotation'
import type { RotationCheckDeps } from './claude-rotation-candidates'
import { checkRotationFolder } from './claude-rotation-check'
import { externalRotatorActive } from './claude-rotation-folders'
import {
  ROTATION_JOURNAL_SERVICE_A,
  ROTATION_JOURNAL_SERVICE_B,
  type ClaudeKeychainSlot,
  type RotationSlotStore
} from './claude-rotation-keychain'
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

  // Both writes landed but the journal still says a_written, and b has since refreshed the login
  // of a it was given: the server names it as a's, so the swap counts as finished, not cancelled.
  const late = setup(['a', 'b'])
  await swapFolderLogins(folder(late.folders, 'a'), folder(late.folders, 'b'), request, late.deps)
  const journal = await late.files.loadJournal()
  if (!journal) {
    throw new Error('missing journal')
  }
  await late.files.saveJournal({ ...journal, step: 'a_written', meta: undefined })
  const refreshedA = {
    ...slotOf('b'),
    claudeAiOauth: { ...login('a'), refreshToken: 'refresh-a2' }
  }
  late.keychain.slots.set('svc-b', refreshedA)
  expect(await recoverInterruptedSwap(late.deps)).toBe('already_finished')
  expect(late.keychain.slots.get('svc-a')?.claudeAiOauth).toEqual(login('b'))
  expect(late.keychain.slots.get('svc-b')).toEqual(refreshedA)
})

/** Orca's account records as two swappable fingerprints; the second save fails, as on a full disk. */
function recordsFailingOnce(): NonNullable<RotationCheckDeps['records']> & {
  swapped: () => boolean
} {
  let saves = 0
  let swapped = false
  return {
    fingerprint: (id) => (swapped ? (id === 'a' ? 'rb' : 'ra') : `r${id}`),
    exchange: async () => {
      saves += 1
      if (saves === 2) {
        return false
      }
      swapped = !swapped
      return true
    },
    swapped: () => swapped
  }
}

it('settles both folders when a session wrote back after a swap cut off before its journal step', async () => {
  // Both writes landed but the journal still says a_written. b then refreshed the login of a it
  // was given, and the session in a wrote its old login back: the only copy of b's is the backup.
  const { folders, keychain, deps, files } = setup(['a', 'b'])
  await swapFolderLogins(folder(folders, 'a'), folder(folders, 'b'), request, deps)
  const journal = await files.loadJournal()
  if (!journal) {
    throw new Error('missing journal')
  }
  await files.saveJournal({ ...journal, step: 'a_written', meta: undefined })
  const refreshedA = {
    ...slotOf('b'),
    claudeAiOauth: { ...login('a'), refreshToken: 'refresh-a2' }
  }
  keychain.slots.set('svc-b', refreshedA)
  keychain.slots.set('svc-a', slotOf('a'))
  expect(await recoverInterruptedSwap(deps)).toBe('already_finished')
  expect(await files.loadJournal()).not.toBeNull()
  // The copy in a is spent once b refreshed it, so a takes b's login from the backup.
  expect((await verifySwap(deps, true))?.outcome).toBe('ok')
  expect(keychain.slots.get('svc-a')).toEqual({ ...slotOf('a'), claudeAiOauth: login('b') })
  expect(keychain.slots.get('svc-b')).toEqual(refreshedA)
  expect(await files.loadJournal()).toBeNull()
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

it('keeps the journal until a rollback has also put the account details back', async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b'])
  const records = recordsFailingOnce()
  deps.records = records
  const a = folder(folders, 'a')
  expect((await swapFolderLogins(a, folder(folders, 'b'), request, deps)).ok).toBe(true)
  keychain.slots.set('svc-a', slotOf('a'))
  expect((await verifySwap(deps, true))?.outcome).toBe('waiting')
  expect(keychain.slots.get('svc-b')).toEqual(slotOf('b'))
  expect(await files.loadJournal()).not.toBeNull()
  // b refreshes its restored login before the retry; the rollback is not mistaken for a conflict.
  const refreshedB = { ...slotOf('b'), claudeAiOauth: { ...login('b'), refreshToken: 'r-b2' } }
  keychain.slots.set('svc-b', refreshedB)
  expect((await verifySwap(deps, true))?.outcome).toBe('reverted')
  expect(keychain.slots.get('svc-b')).toEqual(refreshedB)
  expect(records.swapped()).toBe(false)
  expect(await files.loadJournal()).toBeNull()
})

it('checks both folders again before finishing a rollback whose details were not in place', async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b'])
  const records = recordsFailingOnce()
  deps.records = records
  const a = folder(folders, 'a')
  expect((await swapFolderLogins(a, folder(folders, 'b'), request, deps)).ok).toBe(true)
  keychain.slots.set('svc-a', slotOf('a'))
  expect((await verifySwap(deps, true))?.outcome).toBe('waiting')
  expect(keychain.slots.get('svc-b')).toEqual(slotOf('b'))
  // A session in a then refreshes the incoming login it had read, so the copy put back in b is
  // spent and the login of a is left only in its backup: b takes that backup, finishing the swap.
  const refreshedB = { ...slotOf('a'), claudeAiOauth: { ...login('b'), refreshToken: 'r-b2' } }
  keychain.slots.set('svc-a', refreshedB)
  expect((await verifySwap(deps, true))?.outcome).toBe('ok')
  expect(keychain.slots.get('svc-a')).toEqual(refreshedB)
  expect(keychain.slots.get('svc-b')).toEqual({ ...slotOf('b'), claudeAiOauth: login('a') })
  expect(records.swapped()).toBe(true)
  expect(JSON.parse(readFileSync(a.stateFile, 'utf8')).oauthAccount.emailAddress).toBe(
    'b@example.test'
  )
  expect(await files.loadJournal()).toBeNull()
})

it('does not clear the backups when a writes its old login back while the details are placed', async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b'])
  expect(
    (await swapFolderLogins(folder(folders, 'a'), folder(folders, 'b'), request, deps)).ok
  ).toBe(true)
  // Placing the details reads the backups after the folders were checked and the locks let go.
  const read = keychain.read
  let wroteBack = false
  keychain.read = async (service) => {
    if (service === ROTATION_JOURNAL_SERVICE_A && !wroteBack) {
      wroteBack = true
      keychain.slots.set('svc-a', slotOf('a'))
    }
    return read(service)
  }
  expect((await verifySwap(deps, true))?.outcome).toBe('waiting')
  expect(await files.loadJournal()).not.toBeNull()
  expect((await verifySwap(deps, true))?.outcome).toBe('reverted')
  expect(keychain.slots.get('svc-b')).toEqual(slotOf('b'))
})

it('keeps the backups and pauses switching while a folder holds no login after a swap', async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b'])
  const a = folder(folders, 'a')
  const b = folder(folders, 'b')
  expect((await swapFolderLogins(a, b, request, deps)).ok).toBe(true)
  // The session in a wrote its old login back and b was signed out: b's login is only in a backup.
  keychain.slots.set('svc-a', slotOf('a'))
  keychain.slots.set('svc-b', { mcpOAuth: { server: 'mcp-b' } })
  expect((await verifySwap(deps, true))?.outcome).toBe('needs_repair')
  expect((await verifySwap(deps, true))?.outcome).toBe('waiting')
  expect((await files.loadJournal())?.needsRepair).toBe(true)
  expect(keychain.slots.get(ROTATION_JOURNAL_SERVICE_B)?.claudeAiOauth).toEqual(login('b'))
  expect(await swapFolderLogins(a, b, request, deps)).toEqual({
    ok: false,
    detail: 'previous_swap_unverified'
  })
  // Past the give-up time, a login the server cannot name keeps the journal too.
  deps.now = () => NOW + 1_000_000
  const unnamed = { ...login('b'), accessToken: 'access-x', refreshToken: 'refresh-x' }
  keychain.slots.set('svc-b', { ...slotOf('b'), claudeAiOauth: unnamed })
  expect((await verifySwap(deps, true))?.outcome).toBe('waiting')
  expect(await files.loadJournal()).not.toBeNull()
  // Signing b back in to its own account settles the folders and removes the backups.
  const signedIn = { ...slotOf('b'), claudeAiOauth: { ...login('b'), refreshToken: 'refresh-b2' } }
  keychain.slots.set('svc-b', signedIn)
  expect((await verifySwap(deps, true))?.outcome).toBe('reverted')
  expect(keychain.slots.get('svc-a')).toEqual(slotOf('a'))
  expect(keychain.slots.get('svc-b')).toEqual(signedIn)
  expect(await files.loadJournal()).toBeNull()
  expect([...keychain.slots.keys()].sort()).toEqual(['svc-a', 'svc-b'])
})

it('keeps the backups and reports once when a cut-off swap left a folder without its account', async () => {
  // Both writes landed but the journal still says a_written, and the session in a wrote its old
  // login back: with b holding a third account or none, b's login is left only in its backup.
  const cut = async (slotB: ClaudeKeychainSlot) => {
    const env = setup(['a', 'b'])
    await swapFolderLogins(folder(env.folders, 'a'), folder(env.folders, 'b'), request, env.deps)
    const journal = await env.files.loadJournal()
    if (!journal) {
      throw new Error('missing journal')
    }
    await env.files.saveJournal({ ...journal, step: 'a_written', meta: undefined })
    env.keychain.slots.set('svc-a', slotOf('a'))
    env.keychain.slots.set('svc-b', slotB)
    return env
  }
  for (const slotB of [{ ...slotOf('b'), claudeAiOauth: login('c') }, { mcpOAuth: {} }]) {
    const { keychain, deps, files } = await cut(slotB)
    expect(await recoverInterruptedSwap(deps)).toBe('needs_repair')
    expect(await recoverInterruptedSwap(deps)).toBe('repair_waiting')
    expect((await files.loadJournal())?.needsRepair).toBe(true)
    expect(keychain.slots.get(ROTATION_JOURNAL_SERVICE_B)?.claudeAiOauth).toEqual(login('b'))
  }
  // A login the server cannot name yet is not reported: the lookup may only be down for now.
  const unnamed = { ...login('b'), accessToken: 'access-x', refreshToken: 'refresh-x' }
  const later = await cut({ ...slotOf('b'), claudeAiOauth: unnamed })
  expect(await recoverInterruptedSwap(later.deps)).toBe('undecided')
  expect((await later.files.loadJournal())?.needsRepair).toBeUndefined()
  // Signing b back in to its own account ends the journal, as nothing is only in a backup now.
  const signedIn = { ...slotOf('b'), claudeAiOauth: { ...login('b'), refreshToken: 'refresh-b2' } }
  later.keychain.slots.set('svc-b', signedIn)
  expect(await recoverInterruptedSwap(later.deps)).toBe('nothing_written')
  expect(await later.files.loadJournal()).toBeNull()

  // Cut after the first write, then b took a third account: a's login is only in its backup.
  const third = setup(['a', 'b'])
  third.keychain.crashOnWrite = 4
  await swapFolderLogins(
    folder(third.folders, 'a'),
    folder(third.folders, 'b'),
    request,
    third.deps
  )
  third.keychain.slots.set('svc-b', { ...slotOf('b'), claudeAiOauth: login('c') })
  expect(await recoverInterruptedSwap(third.deps)).toBe('needs_repair')
  expect(third.keychain.slots.get(ROTATION_JOURNAL_SERVICE_A)?.claudeAiOauth).toEqual(login('a'))
  // A third account in a is reported the same way.
  const inA = setup(['a', 'b'])
  inA.keychain.crashOnWrite = 4
  await swapFolderLogins(folder(inA.folders, 'a'), folder(inA.folders, 'b'), request, inA.deps)
  inA.keychain.slots.set('svc-a', { ...slotOf('a'), claudeAiOauth: login('c') })
  expect(await recoverInterruptedSwap(inA.deps)).toBe('needs_repair')
})

it('ends a pending swap once a folder was removed with its account', async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b'])
  const b = folder(folders, 'b')
  expect((await swapFolderLogins(folder(folders, 'a'), b, request, deps)).ok).toBe(true)
  keychain.slots.set('svc-a', slotOf('a'))
  keychain.slots.delete('svc-b')
  rmSync(b.home, { recursive: true, force: true })
  expect((await verifySwap(deps, true))?.outcome).toBe('folder_gone')
  expect(await files.loadJournal()).toBeNull()
  expect([...keychain.slots.keys()]).toEqual(['svc-a'])

  // The same holds for a swap cut off between its writes.
  const cut = setup(['a', 'b'])
  cut.keychain.crashOnWrite = 4
  const cutB = folder(cut.folders, 'b')
  await swapFolderLogins(folder(cut.folders, 'a'), cutB, request, cut.deps)
  cut.keychain.slots.delete('svc-b')
  rmSync(cutB.home, { recursive: true, force: true })
  expect(await recoverInterruptedSwap(cut.deps)).toBe('folder_gone')
  expect(await cut.files.loadJournal()).toBeNull()
})

it('keeps the backups while the journal that points to them is still on disk', async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b'])
  expect(
    (await swapFolderLogins(folder(folders, 'a'), folder(folders, 'b'), request, deps)).ok
  ).toBe(true)
  const removeJournal = files.removeJournal.bind(files)
  let failed = false
  files.removeJournal = async () => {
    if (!failed) {
      failed = true
      throw new Error('disk full')
    }
    return removeJournal()
  }
  expect((await verifySwap(deps, true))?.outcome).toBe('waiting')
  expect(await files.loadJournal()).not.toBeNull()
  expect(keychain.slots.has(ROTATION_JOURNAL_SERVICE_A)).toBe(true)
  expect(keychain.slots.has(ROTATION_JOURNAL_SERVICE_B)).toBe(true)
  expect((await verifySwap(deps, true))?.outcome).toBe('ok')
  expect(await files.loadJournal()).toBeNull()
  expect([...keychain.slots.keys()].sort()).toEqual(['svc-a', 'svc-b'])
})

it('treats files it cannot read as present, not absent', async () => {
  const { folders, keychain, deps } = setup(['a', 'b'])
  const a = folder(folders, 'a')
  chmodSync(a.stateFile, 0)
  const result = await swapFolderLogins(a, folder(folders, 'b'), request, deps)
  chmodSync(a.stateFile, 0o600)
  expect(result).toEqual({ ok: false, detail: 'meta_unreadable' })
  expect(keychain.slots.get('svc-a')).toEqual(slotOf('a'))

  const home = mkdtempSync(join(tmpdir(), 'orca-claude-rotation-home-'))
  roots.push(home)
  const rotate = join(home, '.claude', 'rotate')
  mkdirSync(rotate, { recursive: true })
  expect(await externalRotatorActive(home)).toBe(false)
  chmodSync(rotate, 0)
  const unreadable = await externalRotatorActive(home)
  chmodSync(rotate, 0o700)
  expect(unreadable).toBe(true)
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
    exchange: async (x, y) => {
      const first = records.get(x) ?? ''
      records.set(x, records.get(y) ?? '')
      records.set(y, first)
      return true
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
  preferredAccounts: [ACCOUNT.b],
  accounts: {}
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

it("follows each account's own switch, limits and priority", async () => {
  const { folders, keychain, deps, files } = setup(['a', 'b', 'c'])
  const five: Record<string, number> = { 'access-a': 95, 'access-b': 70, 'access-c': 5 }
  deps.fetchUsage = async (token) => ({ status: 'ok', usage: usage(five[token] ?? 0) })
  const check = async (
    rotation: ClaudeAccountRotationSettings,
    current: ClaudeAccountRotationSettings = rotation
  ) =>
    checkRotationFolder({
      target: folder(folders, 'a'),
      folders: [...folders.values()],
      sessions: new Map(),
      state: await files.loadState(),
      settings: rotation,
      deps,
      currentSettings: async () => current
    })
  const own = (enabled: boolean, fiveHourPercent: number | null = null) => ({
    enabled,
    fiveHourPercent,
    weeklyPercent: null
  })

  // a's own 5-hour limit is 98%, so 95% is no reason to switch yet.
  expect((await check({ ...settings, accounts: { [ACCOUNT.a]: own(true, 98) } }))?.note).toBe('ok')
  // An account taken out of rotation is left alone, even past its limit.
  expect((await check({ ...settings, accounts: { [ACCOUNT.a]: own(false) } }))?.note).toBe(
    'account_off'
  )
  // b is over its own 60% and c is off, so nothing can come in.
  const none = await check({
    ...settings,
    accounts: { [ACCOUNT.b]: own(true, 60), [ACCOUNT.c]: own(false) }
  })
  expect(none && 'skipped' in none ? none.skipped : null).toEqual([
    { accountId: 'b', reason: 'also_near_limit' },
    { accountId: 'c', reason: 'account_off' }
  ])
  expect(keychain.slots.get('svc-a')).toEqual(slotOf('a'))
  // b is turned off while its usage is read: the check right before the write stops the swap.
  const turnedOff = { ...settings, accounts: { [ACCOUNT.b]: own(false) } }
  expect((await check(settings, turnedOff))?.note).toBe('swap_failed')
  expect(keychain.slots.get('svc-a')).toEqual(slotOf('a'))
  // Priority beats use: b (70%) ranks above c (5%).
  expect((await check(settings))?.note).toBe('swapped')
  expect(keychain.slots.get('svc-a')?.claudeAiOauth).toEqual(login('b'))
})
