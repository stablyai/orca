import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { sweepOrphanedRuntimeSockets } from './runtime-rpc-socket-metadata'

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
})
