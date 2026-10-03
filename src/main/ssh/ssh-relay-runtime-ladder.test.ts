import { describe, expect, it } from 'vitest'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_COMPAT_ASSETS } from '../../shared/node-runtime-pin'
import {
  compatRelayRuntimeFor,
  nextRelayRuntimeStep,
  pinnedRuntimeTargetForHost,
  relayRuntimeLadder,
  relayRuntimeStorePins,
  remoteRuntimeUnavailableMessage,
  remoteRuntimeUnavailableReason,
  rungBCompatRuntimeFor
} from './ssh-relay-runtime-ladder'

const COMPAT_SHA = NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217'].executableSha256

describe('relay runtime ladder (design D6)', () => {
  it('keeps the host-npm path alone for Auto and Host Node, and the full ladder for Orca-managed Node', () => {
    expect(relayRuntimeLadder('legacy')).toEqual(['legacy'])
    expect(relayRuntimeLadder('pinned-node')).toEqual(['A', 'B', 'C', 'legacy', 'D'])
  })

  it('steps to the next rung on an ordinary refusal', () => {
    const ladder = relayRuntimeLadder('pinned-node')
    expect(nextRelayRuntimeStep(ladder, 'A', 'libc_floor')).toBe('B')
    expect(nextRelayRuntimeStep(ladder, 'B', 'runtime_unavailable')).toBe('C')
    expect(nextRelayRuntimeStep(ladder, 'C', 'missing_lib')).toBe('legacy')
  })

  it('goes straight to D on noexec, which defeats every rung in the same tree', () => {
    const ladder = relayRuntimeLadder('pinned-node')
    expect(nextRelayRuntimeStep(ladder, 'A', 'noexec')).toBe('D')
    expect(nextRelayRuntimeStep(ladder, 'C', 'noexec')).toBe('D')
  })

  it('lets a remembered noexec skip only its own rung, so a remounted home is re-proved', () => {
    const ladder = relayRuntimeLadder('pinned-node')
    expect(nextRelayRuntimeStep(ladder, 'A', 'noexec', true)).toBe('B')
  })

  it('skips the npm path when rung C found no host Node, since npm needs one too', () => {
    const ladder = relayRuntimeLadder('pinned-node')
    expect(nextRelayRuntimeStep(ladder, 'C', 'host_node_missing')).toBe('D')
  })

  it('chooses rung B only when a listed compat runtime serves the host', () => {
    const facts = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 17 } }
    expect(compatRelayRuntimeFor(facts, [])).toBeNull()
    const catalog = [
      {
        id: 'glibc217',
        runtimeTarget: 'linux-x64-glibc217' as const,
        hostTarget: 'linux-x64-glibc' as const,
        glibcFloor: { major: 2, minor: 17 }
      }
    ]
    expect(compatRelayRuntimeFor(facts, catalog)?.id).toBe('glibc217')
    expect(compatRelayRuntimeFor({ ...facts, glibc: { major: 2, minor: 12 } }, catalog)).toBeNull()
    expect(compatRelayRuntimeFor({ target: 'linux-x64-musl', glibc: null }, catalog)).toBeNull()
    const muslCatalog = [
      {
        id: 'musl',
        runtimeTarget: 'linux-x64-glibc217' as const,
        hostTarget: 'linux-x64-musl' as const,
        glibcFloor: null
      }
    ]
    expect(compatRelayRuntimeFor({ target: 'linux-x64-musl', glibc: null }, muslCatalog)?.id).toBe(
      'musl'
    )
  })

  it('ships the glibc 2.17 compat runtime for linux-x64 hosts', () => {
    const facts = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 17 } }
    expect(compatRelayRuntimeFor(facts)?.runtimeTarget).toBe('linux-x64-glibc217')
    expect(compatRelayRuntimeFor({ target: 'linux-arm64-glibc', glibc: facts.glibc })).toBeNull()
  })

  it('runs rung B below 2.28, or on a newer glibc only after A refused over a library', () => {
    const old = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 27 } }
    const current = { target: 'linux-x64-glibc' as const, glibc: { major: 2, minor: 31 } }
    expect(rungBCompatRuntimeFor(old, 'libc_floor')?.id).toBe('glibc217')
    expect(rungBCompatRuntimeFor(old, null)?.id).toBe('glibc217')
    expect(rungBCompatRuntimeFor(current, 'missing_lib')?.id).toBe('glibc217')
    expect(rungBCompatRuntimeFor(current, 'libc_floor')?.id).toBe('glibc217')
    expect(rungBCompatRuntimeFor(current, 'illegal_instruction')).toBeNull()
    expect(rungBCompatRuntimeFor(current, 'artifacts_unavailable')).toBeNull()
    expect(
      rungBCompatRuntimeFor({ ...old, glibc: { major: 2, minor: 12 } }, 'libc_floor')
    ).toBeNull()
  })

  it('keeps the compat runtime pinned in the store beside the default one', () => {
    const defaultSha = NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256
    expect(relayRuntimeStorePins('linux-x64-glibc')).toEqual([defaultSha, COMPAT_SHA])
    expect(relayRuntimeStorePins('linux-x64-glibc217')).toEqual([defaultSha, COMPAT_SHA])
    expect(relayRuntimeStorePins('linux-arm64-glibc')).toEqual([
      NODE_RUNTIME_ASSETS['linux-arm64-glibc'].executableSha256
    ])
  })

  it('names the runtime a companion can run by glibc alone', () => {
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 28 } })
    ).toBe('linux-x64-glibc')
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 17 } })
    ).toBe('linux-x64-glibc217')
    expect(
      pinnedRuntimeTargetForHost({ target: 'linux-arm64-glibc', glibc: { major: 2, minor: 17 } })
    ).toBeNull()
    expect(pinnedRuntimeTargetForHost({ target: 'linux-x64-musl', glibc: null })).toBe(
      'linux-x64-musl'
    )
  })

  it('names the rung D reason in words the user can act on', () => {
    expect(remoteRuntimeUnavailableReason('noexec')).toBe('home_noexec')
    expect(remoteRuntimeUnavailableReason('host_node_missing')).toBe('no_runtime')
    expect(remoteRuntimeUnavailableMessage('home_noexec', 'noexec')).toContain('mounted noexec')
    expect(remoteRuntimeUnavailableMessage('no_runtime', 'host_node_missing')).toContain(
      'Install Node.js 18+'
    )
  })

  it('never advises installing Node when a remembered noexec defeated the tree', () => {
    expect(remoteRuntimeUnavailableReason('host_node_missing', true)).toBe('home_noexec')
    const message = remoteRuntimeUnavailableMessage('home_noexec', 'noexec', true)
    expect(message).toContain('earlier connect found the home directory')
    expect(message).not.toContain('Install Node.js')
  })
})
