import { assert, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { PtyProviderBufferSnapshot } from '../../../providers/pty/provider-contract'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { RuntimeTerminalRead } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { serializeBudgetedRequestedSnapshot } from '../../rpc/methods/terminal/terminal-snapshot-publication'

const grid = { cols: 80, rows: 24 }

function createRuntime(scrollbackRows?: number) {
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    headlessTerminalScrollbackRows: scrollbackRows
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid
  })
  return runtime
}

// A daemon stream that has stamped its position since attach, at zero offset.
function anchorStream(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'continued' })
  runtime.anchorProviderSequence(ptyId, 0, 0)
}

function historyReads(runtime: OrcaRuntimeService, ptyId: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inherited protected runtime methods retain these signatures.
  const reads = runtime as unknown as {
    recordPtyWorktree(ptyId: string, worktreeId: string): RuntimePtyWorktreeRecord
    readPtyTerminal(
      handle: string,
      pty: RuntimePtyWorktreeRecord,
      opts: { cursor?: number; limit: number }
    ): RuntimeTerminalRead
    withVisibleSnapshotFallback(
      ptyId: string,
      read: RuntimeTerminalRead,
      opts: { cursor?: number; limit: number }
    ): Promise<RuntimeTerminalRead>
  }
  const pty = reads.recordPtyWorktree(ptyId, '/test')
  const stream = (opts = { limit: 2000 }) => reads.readPtyTerminal('term', pty, opts)
  const read = (opts: { cursor?: number; limit: number } = { limit: 2000 }) =>
    reads.withVisibleSnapshotFallback(ptyId, stream(opts), opts)
  return { stream, read }
}

it.each(['gap snapshot', 'clear snapshot', 'clear text'] as const)(
  'fences delayed reader acquisitions across a %s',
  async (path) => {
    const runtime = createRuntime()
    const { read } = historyReads(runtime, 'pty-reader')
    let release: ((snapshot: PtyProviderBufferSnapshot) => void) | undefined
    let mutated = false
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => grid,
      serializeProviderBuffer: async (_ptyId, opts) => {
        if (opts?.recovery) {
          return new Promise<null>((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve(null), { once: true })
          })
        }
        if (!mutated) {
          return new Promise<PtyProviderBufferSnapshot>((resolve) => {
            release = resolve
          })
        }
        return {
          data: 'current screen',
          ...grid,
          seq: runtime.getPtyOutputSequence('pty-reader'),
          source: 'headless'
        }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inherited protected runtime method retains this signature.
    const readers = runtime as unknown as {
      serializeProviderTerminalBuffer(
        ptyId: string,
        opts: { scrollbackRows: number }
      ): Promise<PtyProviderBufferSnapshot | null>
    }
    try {
      anchorStream(runtime, 'pty-reader')
      runtime.onPtyData('pty-reader', 'before', 1)
      if (path !== 'gap snapshot') {
        runtime.notePtyDataGap('pty-reader', 9)
      }
      const old = readers.serializeProviderTerminalBuffer('pty-reader', { scrollbackRows: 1000 })
      assert(release)
      const oldSnapshot: PtyProviderBufferSnapshot = {
        data: 'before',
        scrollbackAnsi: 'OLD-HISTORY\r\n',
        ...grid,
        seq: runtime.getPtyOutputSequence('pty-reader'),
        source: 'headless'
      }
      mutated = true
      if (path === 'gap snapshot') {
        runtime.notePtyDataGap('pty-reader', 9)
        runtime.onPtyData('pty-reader', 'after\r\n', 2)
      } else {
        await runtime.clearHeadlessTerminalBuffer('pty-reader')
      }
      const requested =
        path === 'clear text'
          ? read({ limit: 500 })
          : serializeBudgetedRequestedSnapshot(runtime, 'pty-reader', 1000)
      release(oldSnapshot)
      expect(await old).toBeNull()
      const result = await requested
      assert(result)
      if ('tail' in result) {
        expect(result.tail).toEqual(['current screen'])
        expect(result.limited).toBe(false)
      } else {
        expect(result.data).toBe('current screen')
      }
    } finally {
      await runtime.onPtyExit('pty-reader', 0)
    }
  }
)

it('reports the actual shared acquisition window on capped publications', async () => {
  const runtime = createRuntime()
  let release: ((snapshot: PtyProviderBufferSnapshot) => void) | undefined
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    serializeProviderBuffer: async (_ptyId, opts) => {
      if (opts?.recovery) {
        return new Promise<null>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve(null), { once: true })
        })
      }
      return new Promise<PtyProviderBufferSnapshot>((resolve) => {
        release = resolve
      })
    }
  })
  try {
    anchorStream(runtime, 'pty-window')
    runtime.notePtyDataGap('pty-window', 9)
    const larger = serializeBudgetedRequestedSnapshot(runtime, 'pty-window', 1000)
    const smaller = serializeBudgetedRequestedSnapshot(runtime, 'pty-window', 500)
    assert(release)
    release({ data: 'current screen', ...grid, seq: 9, source: 'headless' })
    expect((await larger)?.scrollbackRows).toBe(1000)
    expect((await smaller)?.scrollbackRows).toBe(1000)
  } finally {
    await runtime.onPtyExit('pty-window', 0)
  }
})
