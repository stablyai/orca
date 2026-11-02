import { describe, expect, it } from 'vitest'
import {
  createWorktreePreparationLockReason,
  isWorktreeCreatePreparation,
  parseWorktreePreparationOwnerMachine,
  parseWorktreePreparationOwnerPid
} from '../shared/worktree/create-preparation'
import {
  preparationOwnerExitedHere,
  type PreparationOwnerProbe
} from './worktree-create-preparation-stale-cleanup'

const MACHINE_A = '0123456789abcdef0123456789abcdef'
const MACHINE_B = 'fedcba9876543210fedcba9876543210'
const REPO = '/home/dev/repo'

function probe(overrides: Partial<PreparationOwnerProbe> = {}): PreparationOwnerProbe {
  return {
    machineIdentity: () => MACHINE_A,
    repoIsOnLocalDisk: () => true,
    isProcessAlive: () => false,
    ...overrides
  }
}

const reasonFrom = (machine: string | null): string =>
  `orca-create-preparation:v1:4242:4242-11111111-1111-4111-8111-111111111111${
    machine ? `:machine=${machine}` : ''
  }`

describe('preparation lock reasons', () => {
  it('records the writer machine without changing the pid older builds read', () => {
    const reason = createWorktreePreparationLockReason('session', `win32-machine-guid:${MACHINE_A}`)
    expect(parseWorktreePreparationOwnerPid(reason)).toBe(process.pid)
    expect(parseWorktreePreparationOwnerMachine(reason)).toBe(`win32-machine-guid:${MACHINE_A}`)
    expect(isWorktreeCreatePreparation({ path: '/w', lockReason: reason })).toBe(true)
    // What a pre-fix build reads: the first field after the prefix.
    expect(Number(reason.slice('orca-create-preparation:v1:'.length).split(':')[0])).toBe(
      process.pid
    )
  })

  it('omits the machine when the writer cannot identify it', () => {
    const reason = createWorktreePreparationLockReason('session', null)
    expect(reason).toBe(`orca-create-preparation:v1:${process.pid}:session`)
    expect(parseWorktreePreparationOwnerMachine(reason)).toBeNull()
  })
})

describe('preparationOwnerExitedHere', () => {
  // Two hosts sharing an NFS repo: B's pid 4242 is absent on A, though B is still preparing.
  it('never reads an owner on another machine as exited', () => {
    expect(preparationOwnerExitedHere(reasonFrom(MACHINE_B), REPO, {}, probe())).toBe(false)
  })

  it('never reads a machine-scoped owner as exited when this host has no identity', () => {
    expect(
      preparationOwnerExitedHere(
        reasonFrom(MACHINE_B),
        REPO,
        {},
        probe({ machineIdentity: () => null })
      )
    ).toBe(false)
  })

  it('reads a dead owner on this machine as exited, and a live one as not', () => {
    expect(preparationOwnerExitedHere(reasonFrom(MACHINE_A), REPO, {}, probe())).toBe(true)
    expect(
      preparationOwnerExitedHere(
        reasonFrom(MACHINE_A),
        REPO,
        {},
        probe({ isProcessAlive: () => true })
      )
    ).toBe(false)
  })

  it('judges a reason with no machine by pid only on a disk no other host sees', () => {
    expect(preparationOwnerExitedHere(reasonFrom(null), REPO, {}, probe())).toBe(true)
    expect(
      preparationOwnerExitedHere(
        reasonFrom(null),
        REPO,
        {},
        probe({ repoIsOnLocalDisk: () => false })
      )
    ).toBe(false)
    // A WSL repo belongs to this machine's own distro.
    expect(
      preparationOwnerExitedHere(
        reasonFrom(null),
        '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
        { wslDistro: 'Ubuntu' },
        probe({ repoIsOnLocalDisk: () => false })
      )
    ).toBe(true)
  })

  it('ignores reasons that are not preparation locks', () => {
    expect(preparationOwnerExitedHere('active agent session', REPO, {}, probe())).toBe(false)
  })
})
