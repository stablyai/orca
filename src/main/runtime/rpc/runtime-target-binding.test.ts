import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-environment'
import type { OrcaRuntimeService } from '../orca-runtime'
import { isOrchestrationMutation } from '../../../shared/orchestration-rpc-contract'
import {
  assertExpectedRuntimeTarget,
  RuntimeTargetMismatch,
  TARGET_BOUND_METHODS
} from './runtime-target-binding'

const NATIVE = realpathSync(mkdtempSync(join(tmpdir(), 'orca-native-')))
const CANDIDATE = realpathSync(mkdtempSync(join(tmpdir(), 'orca-candidate-')))

function runtimeOn(userDataPath: string): OrcaRuntimeService {
  setAppEnvironment({
    getVersion: () => '1.4.178-rc.2',
    getPath: (name) => (name === 'userData' ? userDataPath : tmpdir())
  } as never)
  return {
    getStatus: () => ({ runtimeId: 'runtime_native' }),
    getBuildIdentity: () => ({ id: 'build_native' })
  } as unknown as OrcaRuntimeService
}

describe('a mutation must reach the runtime it was aimed at', () => {
  it('NEGATIVE CONTROL: a candidate-aimed certification call that lands on native is refused', () => {
    // The incident: ORCA_DEV_USER_DATA_PATH named the candidate, the CLI resolved
    // the packaged app's directory instead, and the call reached the NATIVE
    // runtime. It failed on a not-found lookup — nothing in the path stopped it.
    const native = runtimeOn(NATIVE)
    expect(() =>
      assertExpectedRuntimeTarget(
        native,
        'orchestration.certificationIntent',
        { expectUserDataPath: CANDIDATE },
        'local_socket'
      )
    ).toThrow(RuntimeTargetMismatch)
  })

  it('NEGATIVE CONTROL: a certification call that declares no target at all is refused', () => {
    // An OPTIONAL declaration closes nothing: the invocation that caused the
    // incident declared nothing.
    const native = runtimeOn(NATIVE)
    // Every ORCHESTRATION MUTATION is bound, which is the set that can change
    // state. `gatePlan` without `--record` only plans, so it is a read and is
    // deliberately not in it.
    for (const method of TARGET_BOUND_METHODS) {
      if (!isOrchestrationMutation(method, { run: 'run_1' })) {
        continue
      }
      expect(() =>
        assertExpectedRuntimeTarget(native, method, { run: 'run_1' }, 'local_socket')
      ).toThrow(/must name the Orca state root/)
    }
    // And the whole mutation set really is covered, not just whatever happens
    // to be in the hand-written list.
    expect(TARGET_BOUND_METHODS.has('orchestration.workerStart')).toBe(true)
    expect(TARGET_BOUND_METHODS.has('orchestration.phaseLaunch')).toBe(true)
  })

  it('surfaces as its own bounded structured RPC error, not the target method’s', () => {
    const native = runtimeOn(NATIVE)
    try {
      assertExpectedRuntimeTarget(
        native,
        'orchestration.certify',
        { expectUserDataPath: CANDIDATE },
        'local_socket'
      )
      expect.unreachable('should have thrown')
    } catch (error) {
      const mismatch = error as RuntimeTargetMismatch
      expect(mismatch.code).toBe('runtime_target_mismatch')
      expect(mismatch.data).toMatchObject({
        method: 'orchestration.certify',
        expected: { userDataPath: CANDIDATE },
        actual: { userDataPath: NATIVE, runtimeId: 'runtime_native', buildId: 'build_native' }
      })
    }
  })

  it('admits the call that reached the runtime its state root belongs to', () => {
    expect(() =>
      assertExpectedRuntimeTarget(
        runtimeOn(CANDIDATE),
        'orchestration.certificationIntent',
        { expectUserDataPath: CANDIDATE },
        'local_socket'
      )
    ).not.toThrow()
  })

  it('compares state roots by resolved path, so a symlinked spelling still matches', () => {
    const link = join(realpathSync(tmpdir()), `orca-link-${process.pid}`)
    symlinkSync(CANDIDATE, link)
    expect(() =>
      assertExpectedRuntimeTarget(
        runtimeOn(CANDIDATE),
        'orchestration.certify',
        { expectUserDataPath: link },
        'local_socket'
      )
    ).not.toThrow()
  })

  it('refuses when the runtime cannot read its own state root', () => {
    setAppEnvironment({
      getVersion: () => '1.4.178-rc.2',
      getPath: () => {
        throw new Error('no app root here')
      }
    } as never)
    const blind = {
      getStatus: () => ({ runtimeId: 'r' }),
      getBuildIdentity: () => ({ id: 'b' })
    } as unknown as OrcaRuntimeService
    expect(() =>
      assertExpectedRuntimeTarget(
        blind,
        'orchestration.gateRun',
        { expectUserDataPath: CANDIDATE },
        'local_socket'
      )
    ).toThrow(/cannot read its own/)
  })

  it('leaves an ordinary read on an unbound method alone', () => {
    expect(() =>
      assertExpectedRuntimeTarget(runtimeOn(NATIVE), 'git.status', {}, 'local_socket')
    ).not.toThrow()
  })

  it('still refuses a declared runtimeId or buildId that does not match', () => {
    const native = runtimeOn(NATIVE)
    expect(() =>
      assertExpectedRuntimeTarget(
        native,
        'git.commit',
        { expectUserDataPath: NATIVE, expectRuntimeId: 'runtime_candidate' },
        'local_socket'
      )
    ).toThrow(RuntimeTargetMismatch)
    expect(() =>
      assertExpectedRuntimeTarget(
        native,
        'git.commit',
        { expectUserDataPath: NATIVE, expectBuildId: 'build_candidate' },
        'local_socket'
      )
    ).toThrow(RuntimeTargetMismatch)
  })
})

describe('a paired remote target is bound by its credential, not by a path', () => {
  it('admits a remote workerStart with no path: the pairing already authenticated one runtime', () => {
    // A local filesystem path means nothing on another host and must never be
    // sent there, so requiring one would have broken every remote certification
    // and worker start outright.
    for (const method of TARGET_BOUND_METHODS) {
      expect(() =>
        assertExpectedRuntimeTarget(
          runtimeOn(NATIVE),
          method,
          { run: 'run_1' },
          'authenticated_remote'
        )
      ).not.toThrow()
    }
  })

  it('still refuses a remote call that names the wrong runtime', () => {
    expect(() =>
      assertExpectedRuntimeTarget(
        runtimeOn(NATIVE),
        'orchestration.workerStart',
        { expectRuntimeId: 'runtime_somewhere_else' },
        'authenticated_remote'
      )
    ).toThrow(RuntimeTargetMismatch)
  })

  it('admits a remote call that names this runtime', () => {
    expect(() =>
      assertExpectedRuntimeTarget(
        runtimeOn(NATIVE),
        'orchestration.workerStart',
        { expectRuntimeId: 'runtime_native' },
        'authenticated_remote'
      )
    ).not.toThrow()
  })
})

describe('in-process dispatch has no target to confuse', () => {
  it('requires no stamp when the caller is holding the runtime object', () => {
    for (const method of TARGET_BOUND_METHODS) {
      expect(() =>
        assertExpectedRuntimeTarget(runtimeOn(NATIVE), method, { run: 'run_1' })
      ).not.toThrow()
    }
  })

  it('but still verifies whatever it does declare', () => {
    expect(() =>
      assertExpectedRuntimeTarget(runtimeOn(NATIVE), 'orchestration.certify', {
        expectRuntimeId: 'runtime_elsewhere'
      })
    ).toThrow(RuntimeTargetMismatch)
  })
})
