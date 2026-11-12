import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import '../rpc/dispatcher'
import '../rpc/methods/terminal/terminal'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'

// CJ6: a host-owned current frame used to join an outstanding deep history read and fail with it.
describe('host-owned terminal current frame', () => {
  async function hostOwnedTerminal(mainRows: string) {
    // The daemon frame is current: it covers every byte the stream delivered.
    let frameSeq = 0
    const serializeProviderBuffer = vi.fn((_ptyId: string, opts?: { scrollbackRows?: number }) =>
      (opts?.scrollbackRows ?? 0) > 0
        ? new Promise<never>(() => {})
        : Promise.resolve({
            data: 'PROVIDER_SCREEN_ROW\r\n',
            cols: 80,
            rows: 24,
            seq: frameSeq,
            source: 'headless' as const,
            alternateScreen: false
          })
    )
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer,
      hasRendererSerializer: () => false,
      getTerminalHistoryAuthority: () => ({ owner: 'host', incarnationId: 'incarnation-1' })
    })
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', mainRows, 100)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-1',
      { value: 900, generation: 'continued' },
      0
    )
    frameSeq = runtime.getPtyOutputSequence('pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    // A retained-history read that never answers.
    void runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    await vi.waitFor(() => expect(serializeProviderBuffer).toHaveBeenCalled())
    return { runtime, handle: terminal.handle }
  }

  it('answers --screen from the daemon frame, not main rows, while a deep read stalls', async () => {
    const { runtime, handle } = await hostOwnedTerminal('MAIN_ONLY_ROW\r\n')

    const read = await runtime.readTerminal(handle, { screen: true })

    expect(read.source).not.toBe('screen-unavailable')
    expect(read.tail.join('\n')).toContain('PROVIDER_SCREEN_ROW')
    expect(read.tail.join('\n')).not.toContain('MAIN_ONLY_ROW')
  })

  it('fills a blank stream read from the daemon frame while a deep read stalls', async () => {
    const { runtime, handle } = await hostOwnedTerminal(' \r\n'.repeat(200))

    const read = await runtime.readTerminal(handle)

    expect(read.tail.join('\n')).toContain('PROVIDER_SCREEN_ROW')
  })
})
