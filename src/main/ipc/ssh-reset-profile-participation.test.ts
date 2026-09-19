import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  captureProfileLifetimeParticipation,
  type ProfileLifetimeParticipation
} from '../ssh/profile-lifetime-participation'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetRetirementSelection,
  sshRelayResetRecordDigest as digest
} from '../ssh/ssh-relay-reset-retirement-record'
import { SshRelayResetRecordFiles } from '../ssh/ssh-relay-reset-record-files'
import { SSH_RESET_CLIENT_INCARNATION } from './pty/provider/ssh-reset-route-retirement'
import {
  prepareSshResetProfileParticipation,
  readSshResetProfileParticipation
} from './ssh-reset-profile-participation'

const current = vi.hoisted(() => vi.fn<() => ProfileLifetimeParticipation | null>())
vi.mock('../ssh/profile-lifetime-admission', () => ({
  readCurrentProfileLifetimeParticipation: current
}))
let root: string
let participant: ProfileLifetimeParticipation
const intent = parseSshRelayResetIntent({
  version: 1,
  targetId: 'target',
  targetGeneration: 1,
  targetRoutingDigest: 'a'.repeat(64),
  clientInstanceId: 'client',
  serverBuildId: 'build',
  endpoint: {
    relayDir: '/relay',
    runtimePath: '/relay/bun',
    runtimeKind: 'bun',
    sockPath: '/relay/socket',
    credentialFile: '/relay/credential',
    relayPlatform: 'linux-x64'
  },
  request: {
    version: 1,
    operationId: 'reset',
    runtimeIncarnation: 'daemon',
    ownerGeneration: 1,
    ownerLease: 'lease'
  }
})
const selection = parseSshRelayResetRetirementSelection(
  {
    version: 1,
    intentSha256: digest(intent),
    clientIncarnation: SSH_RESET_CLIENT_INCARNATION,
    retiredAt: 1,
    leases: [],
    routes: []
  },
  intent
)
const file = () =>
  new SshRelayResetRecordFiles(join(root, 'ssh-reset-profile-participation')).path(digest(intent))
const prepare = (assertAuthority = () => {}) =>
  prepareSshResetProfileParticipation({ root, intent, selection, assertAuthority })!

beforeEach(() => {
  current.mockReset()
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-reset-participation-')))
  writeFileSync(join(root, 'profile-lifetime.lock'), '')
  participant = captureProfileLifetimeParticipation(root, randomUUID(), () => {})
  current.mockReturnValue(participant)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it('writes exact retry evidence and binds an independent reader to intent and selection', async () => {
  const persist = prepare()
  const assertDurable = await persist()
  assertDurable()
  expect(readSshResetProfileParticipation(root, intent, selection)).toMatchObject({
    participation: participant,
    clientIncarnation: SSH_RESET_CLIENT_INCARNATION,
    intentSha256: digest(intent),
    selectionSha256: digest(selection)
  })
  await persist()
  expect(() =>
    readSshResetProfileParticipation(root, intent, { ...selection, retiredAt: 2 })
  ).toThrow('binding_changed')
})

it('leaves legacy clients and absent historical records untouched', () => {
  current.mockReturnValue(null)
  expect(prepare()).toBeUndefined()
  expect(readSshResetProfileParticipation(root, intent, selection)).toBeNull()
  expect(existsSync(join(root, 'ssh-reset-profile-participation'))).toBe(false)
})

it('cannot backfill participation for a different originating client', () => {
  expect(() =>
    prepareSshResetProfileParticipation({
      root,
      intent,
      selection: { ...selection, clientIncarnation: randomUUID() },
      assertAuthority: () => {}
    })
  ).toThrow('foreign_client')
  expect(existsSync(file())).toBe(false)
})

it('refuses another physical root before creating its record directory', () => {
  current.mockReturnValue({ ...participant, physicalRoot: join(root, 'other') })
  expect(() => prepare()).toThrow('root_changed')
  expect(existsSync(file())).toBe(false)
})

it('refuses loss of current participation before persistence', async () => {
  const persist = prepare()
  current.mockReturnValue(null)
  await expect(persist()).rejects.toThrow('participation_changed')
  expect(existsSync(file())).toBe(false)
})

it('rechecks authority after the asynchronous file-lock acquisition', async () => {
  let calls = 0
  const persist = prepare(() => {
    if (++calls > 1) {
      throw new Error('authority_lost')
    }
  })
  await expect(persist()).rejects.toThrow('authority_lost')
  expect(existsSync(file())).toBe(false)
})

it('retains a conflict instead of replacing another process participation', async () => {
  await prepare()()
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  await expect(prepare()()).rejects.toThrow('conflict')
  expect(readSshResetProfileParticipation(root, intent, selection)?.participation).toEqual(
    participant
  )
})

it('retained durability proof detects deletion or malformed replacement', async () => {
  const assertDurable = await prepare()()
  rmSync(file())
  expect(assertDurable).toThrow('write_unconfirmed')
  writeFileSync(file(), '{}')
  expect(assertDurable).toThrow()
})
