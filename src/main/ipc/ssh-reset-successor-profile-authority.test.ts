import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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
import { retainSshResetSuccessorProfileAuthority } from './ssh-reset-successor-profile-authority'

const current = vi.hoisted(() => vi.fn<() => ProfileLifetimeParticipation | null>())
vi.mock('../ssh/profile-lifetime-admission', () => ({
  readCurrentProfileLifetimeParticipation: current
}))
const intent = parseSshRelayResetIntent({
  version: 1,
  targetId: 'target',
  targetGeneration: 1,
  targetRoutingDigest: 'a'.repeat(64),
  clientInstanceId: 'client',
  serverBuildId: 'build',
  endpoint: {
    relayDir: '/relay',
    runtimePath: '/bun',
    runtimeKind: 'bun',
    sockPath: '/socket',
    credentialFile: '/credential',
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
let directory: string
let root: string
let participant: ProfileLifetimeParticipation
let selection: ReturnType<typeof parseSshRelayResetRetirementSelection>
const path = () =>
  new SshRelayResetRecordFiles(join(root, 'ssh-reset-profile-participation')).path(digest(intent))
const retain = () => retainSshResetSuccessorProfileAuthority(root, intent, selection)
function writeEvidence(participation = participant) {
  mkdirSync(join(root, 'ssh-reset-profile-participation'), { recursive: true })
  writeFileSync(
    path(),
    JSON.stringify({
      version: 1,
      intentSha256: digest(intent),
      selectionSha256: digest(selection),
      clientIncarnation: selection.clientIncarnation,
      participation
    })
  )
}
beforeEach(() => {
  current.mockReset()
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-reset-successor-')))
  root = join(directory, 'profile')
  mkdirSync(root)
  writeFileSync(join(root, 'profile-lifetime.lock'), '')
  participant = captureProfileLifetimeParticipation(root, randomUUID(), () => {})
  current.mockReturnValue({ ...participant, processIncarnation: randomUUID() })
  selection = parseSshRelayResetRetirementSelection(
    {
      version: 1,
      intentSha256: digest(intent),
      clientIncarnation: randomUUID(),
      retiredAt: 1,
      leases: [],
      routes: []
    },
    intent
  )
  writeEvidence()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('retains exact originating evidence read-only under a different current holder', () => {
  const before = readFileSync(path())
  const assertCurrent = retain()
  assertCurrent()
  expect(readFileSync(path())).toEqual(before)
})

it('never repairs absent historical evidence', () => {
  rmSync(path())
  expect(retain).toThrow('participation_missing')
})

it('refuses the originating client even when supplied a different native holder', () => {
  selection = { ...selection, clientIncarnation: SSH_RESET_CLIENT_INCARNATION }
  writeEvidence()
  expect(retain).toThrow('same_client')
})

it('refuses the originating native holder despite a different client identifier', () => {
  current.mockReturnValue(participant)
  expect(retain).toThrow('same_process')
})

it('refuses disabled participation rather than accepting a durable record alone', () => {
  current.mockReturnValue(null)
  expect(retain).toThrow('participation_unavailable')
})

it('binds evidence to the exact selection', () => {
  selection = { ...selection, retiredAt: selection.retiredAt + 1 }
  expect(retain).toThrow('binding_changed')
})

it('refuses evidence for another physical root', () => {
  const foreign = { ...participant, physicalRoot: join(directory, 'other') }
  writeEvidence(foreign)
  current.mockReturnValue({ ...foreign, processIncarnation: randomUUID() })
  expect(retain).toThrow('profile_changed')
})

it.each(['delete', 'malformed', 'replace'] as const)(
  'retained proof refuses sidecar %s',
  (change) => {
    const assertCurrent = retain()
    if (change === 'delete') {
      rmSync(path())
    } else if (change === 'malformed') {
      writeFileSync(path(), '{}')
    } else {
      writeEvidence({ ...participant, processIncarnation: randomUUID() })
    }
    expect(assertCurrent).toThrow()
  }
)

it('retained proof refuses profile replacement even when its path is unchanged', () => {
  const assertCurrent = retain()
  renameSync(root, join(directory, 'previous'))
  mkdirSync(root)
  expect(assertCurrent).toThrow('identity_changed')
})

it('retained proof rechecks current native authority', () => {
  const assertCurrent = retain()
  current.mockImplementation(() => {
    throw new Error('native_lock_lost')
  })
  expect(assertCurrent).toThrow('native_lock_lost')
})
