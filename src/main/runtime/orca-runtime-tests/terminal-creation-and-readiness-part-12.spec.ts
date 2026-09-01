import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

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

  it('applies ANSI erase-from-start line controls in retained previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABCDE\x1b[3D\x1b[1KXY\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['  XYE'])
    expect(read.tail.join('\n')).not.toContain('ABC')
    expect(read.tail.join('\n')).not.toContain('1K')
  })

  it('applies ANSI stripping for private or intermediate CSI line controls', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABCDE\x1b[?99DXY\n', 100)
    runtime.onPtyData('pty-1', 'ABCDE\x1b[1$DXY\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['ABCDEXY', 'ABCDEXY'])
    expect(read.tail.join('\n')).not.toContain('?99D')
    expect(read.tail.join('\n')).not.toContain('1$D')
  })

  it('applies ANSI stripping for unsupported erase-line modes', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Old\x1b[3KNew\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['OldNew'])
    expect(read.tail.join('\n')).not.toContain('3K')
  })

  it('does not retain split ST-terminated string controls as preview text', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Before \x1b_Gi=31337,s=1,', 100)
    runtime.onPtyData('pty-1', 'v=1,a=q,t=d,f=24;AAAA\x1b\\After\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    const retained = read.tail.join('\n')
    expect(retained).toContain('BeforeAfter')
    expect(retained).not.toContain('Gi=31337')
    expect(retained).not.toContain('AAAA')
  })
})
