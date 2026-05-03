import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  createRuntimeTransportMetadata,
  RUNTIME_SOCKET_NAME_REGEX,
  sweepOrphanedRuntimeSockets
} from './runtime-rpc'

describe('sweepOrphanedRuntimeSockets', () => {
  // Why: a pid we know is always alive and is never the test runner's own
  // pid — init on POSIX, so process.kill(1, 0) resolves without ESRCH. Using
  // this synthetic pid for ownPid cleanly separates three retention branches
  // (own-pid-skipped / alive-non-own-retained / dead-swept) into distinct
  // observations.
  const SYNTHETIC_OWN_PID = 1
  const KNOWN_DEAD_PID = 99999999

  it.runIf(process.platform !== 'win32')(
    'sweeps dead-pid sockets while retaining own, alive, and non-matching entries',
    () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-sweep-'))

      const ownPidSocket = join(userDataPath, `o-${SYNTHETIC_OWN_PID}-aaaa.sock`)
      const aliveSocket = join(userDataPath, `o-${process.pid}-bbbb.sock`)
      const deadSocket = join(userDataPath, `o-${KNOWN_DEAD_PID}-cccc.sock`)
      const unrelatedFile = join(userDataPath, 'foo.sock')

      writeFileSync(ownPidSocket, '')
      writeFileSync(aliveSocket, '')
      writeFileSync(deadSocket, '')
      writeFileSync(unrelatedFile, '')

      sweepOrphanedRuntimeSockets(userDataPath, SYNTHETIC_OWN_PID)

      // Why: own pid (1) is skipped by the ownPid === pid early-exit.
      expect(existsSync(ownPidSocket)).toBe(true)
      // Why: alive non-own pid — process.kill(pid, 0) succeeds without
      // throwing, so the sweep leaves it alone.
      expect(existsSync(aliveSocket)).toBe(true)
      // Why: dead pid — process.kill throws ESRCH, sweep removes it.
      expect(existsSync(deadSocket)).toBe(false)
      // Why: regex miss — not `o-<digits>-<suffix>.sock` shape, so the
      // sweep never touches it.
      expect(existsSync(unrelatedFile)).toBe(true)
    }
  )

  it('tolerates a non-existent userData directory', () => {
    const userDataPath = join(tmpdir(), `orca-sweep-missing-${Date.now()}`)

    expect(() => sweepOrphanedRuntimeSockets(userDataPath, SYNTHETIC_OWN_PID)).not.toThrow()
  })

  it('regex invariant: matches sockets produced by createRuntimeTransportMetadata', () => {
    // Why: if the socket-name factory ever changes shape (e.g. adds a new
    // separator or allows different characters), the sweep will silently
    // stop matching real sockets. Assert the two stay in lockstep.
    const userDataPath = '/tmp'
    const transport = createRuntimeTransportMetadata(userDataPath, 12345, 'linux', 'rt_abcdef')
    expect(transport.kind).toBe('unix')
    if (transport.kind !== 'unix') {
      throw new Error('expected unix transport')
    }
    const basename = transport.endpoint.slice(transport.endpoint.lastIndexOf('/') + 1)
    expect(RUNTIME_SOCKET_NAME_REGEX.test(basename)).toBe(true)
  })

  it('regex invariant: also matches the fallback runtimeId suffix ("rt")', () => {
    // Why: createRuntimeTransportMetadata falls back to the literal 'rt'
    // suffix when the runtimeId contains no allowed characters; the sweep
    // regex must still match that shape.
    const userDataPath = '/tmp'
    const transport = createRuntimeTransportMetadata(userDataPath, 99, 'darwin', '!!!!')
    if (transport.kind !== 'unix') {
      throw new Error('expected unix transport')
    }
    const basename = transport.endpoint.slice(transport.endpoint.lastIndexOf('/') + 1)
    expect(RUNTIME_SOCKET_NAME_REGEX.test(basename)).toBe(true)
    expect(basename).toBe('o-99-rt.sock')
  })
})
