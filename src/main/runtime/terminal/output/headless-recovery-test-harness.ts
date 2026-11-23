import { assert } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import type {
  RuntimeHeadlessTerminal,
  RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import type { RuntimeTerminalRead } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

export const grid = { cols: 80, rows: 24 }

export function createRuntime(scrollbackRows?: number) {
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
export function anchorStream(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.synchronizePtyOutputSequenceFromProvider(ptyId, { value: 0, generation: 'continued' })
  runtime.anchorProviderSequence(ptyId, 0, 0)
}

export async function replay(
  snapshot: { data: string; pendingEscapeTailAnsi?: string } | null,
  suffix: string
) {
  assert(snapshot)
  const restored = new HeadlessEmulator(grid)
  try {
    await restored.write(snapshot.data)
    await restored.write(snapshot.pendingEscapeTailAnsi ?? '')
    await restored.write(suffix)
    return restored
      .getVisibleLines()
      .map((line) => line.trimEnd())
      .filter(Boolean)
  } finally {
    restored.dispose()
  }
}

export const headlessOf = (runtime: OrcaRuntimeService) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits this protected method with exactly this signature.
  runtime as unknown as {
    serializeHeadlessTerminalBuffer(ptyId: string): Promise<{ data: string } | null>
    readWholeScreenModel(ptyId: string): RuntimeHeadlessTerminal | null
    readCaughtUpRuledScreen(ptyId: string): { lines: string[]; alternateScreen: boolean } | null
    readScreenProjection(ptyId: string, limit?: number): Promise<{ lines: string[] } | null>
    visibleSnapshotPreview(ptyId: string, preview: string): Promise<{ preview: string }>
  }

// As the provider listener delivers a frame the daemon stamped with its stream position.
export const stamped = (runtime: OrcaRuntimeService, ptyId: string, data: string, seq: number) =>
  runtime.anchorProviderSequence(ptyId, runtime.onPtyData(ptyId, data, 2), seq)

export const historyGrid = { cols: 80, rows: 5 }

export function historyReads(runtime: OrcaRuntimeService, ptyId: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inherited protected runtime methods retain these signatures.
  const reads = runtime as unknown as {
    recordPtyWorktree(ptyId: string, worktreeId: string): RuntimePtyWorktreeRecord
    readPtyTerminal(
      handle: string,
      pty: RuntimePtyWorktreeRecord,
      opts: { limit: number }
    ): RuntimeTerminalRead
    withVisibleSnapshotFallback(
      ptyId: string,
      read: RuntimeTerminalRead,
      opts: { limit: number }
    ): Promise<RuntimeTerminalRead>
    headlessTerminals: Map<string, RuntimeHeadlessTerminal>
  }
  const pty = reads.recordPtyWorktree(ptyId, '/test')
  const stream = () => reads.readPtyTerminal('term', pty, { limit: 2000 })
  const read = () => reads.withVisibleSnapshotFallback(ptyId, stream(), { limit: 2000 })
  return { stream, read, models: reads.headlessTerminals }
}
