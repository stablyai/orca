import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createRuntimeTransportMetadata,
  RUNTIME_SOCKET_NAME_REGEX,
  sweepOrphanedRuntimeSockets
} from './runtime-rpc/runtime-rpc-socket-metadata'

describe('sweepOrphanedRuntimeSockets', () => {
  // Use an always-live non-runner pid (POSIX init) to distinguish own-pid skip, live sibling retention and dead sweep.
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

      expect(existsSync(ownPidSocket)).toBe(true)
      expect(existsSync(aliveSocket)).toBe(true)
      expect(existsSync(deadSocket)).toBe(false)
      expect(existsSync(unrelatedFile)).toBe(true)
    }
  )

  it('tolerates a non-existent userData directory', () => {
    const userDataPath = join(tmpdir(), `orca-sweep-missing-${Date.now()}`)

    expect(() => sweepOrphanedRuntimeSockets(userDataPath, SYNTHETIC_OWN_PID)).not.toThrow()
  })

  it('regex invariant: matches sockets produced by createRuntimeTransportMetadata', () => {
    // Pin factory and sweep naming together or new socket shapes silently stop matching.
    const userDataPath = '/tmp'
    const transport = createRuntimeTransportMetadata(userDataPath, 12345, 'linux', 'rt_abcdef')
    expect(transport.kind).toBe('unix')
    if (transport.kind !== 'unix') {
      throw new Error('expected unix transport')
    }
    const socketName = basename(transport.endpoint)
    expect(RUNTIME_SOCKET_NAME_REGEX.test(socketName)).toBe(true)
  })

  it('regex invariant: also matches the fallback runtimeId suffix ("rt")', () => {
    // Even sanitized runtime ids with fallback suffix rt must match sweep naming.
    const userDataPath = '/tmp'
    const transport = createRuntimeTransportMetadata(userDataPath, 99, 'darwin', '!!!!')
    if (transport.kind !== 'unix') {
      throw new Error('expected unix transport')
    }
    const socketName = basename(transport.endpoint)
    expect(RUNTIME_SOCKET_NAME_REGEX.test(socketName)).toBe(true)
    expect(socketName).toBe('o-99-rt.sock')
  })
})
