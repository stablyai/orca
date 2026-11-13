import { describe, expect, it } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('bounds retained work for many newline-separated huge ANSI cursor movements', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\x1b[4000GZ\n'.repeat(3000), 100)

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 2000 })
    expect(read.latestCursor).toBe('3000')
    expect(read.oldestCursor).not.toBe('0')
    expect(read.tail.length).toBeLessThan(100)
    for (const line of read.tail) {
      expect(line.length).toBeLessThanOrEqual(4000)
      expect(line.endsWith('Z')).toBe(true)
      expect(line).not.toContain('4000G')
    }
  })
})
