import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { readProcessRows } from './idle-cpu-process-sampling.mjs'

describe.skipIf(process.platform !== 'win32')('Windows process table read', () => {
  // Timeout exceeds reader’s 60s bound; cold PowerShell 5.1 has reached 48s on CI, so this is not a latency budget.
  it('parses a command line whose characters the OEM code page maps to control bytes', () => {
    const marker = 'idle-cpu-oem • → ♪'
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', marker], {
      stdio: 'ignore'
    })
    try {
      const row = readProcessRows().find((candidate) => candidate.pid === child.pid)
      expect(row?.command).toContain(marker)
      expect(row?.cpuTimeSeconds).toEqual(expect.any(Number))
    } finally {
      child.kill()
    }
  }, 75_000)
})
