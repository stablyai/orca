import { expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import {
  TerminalStreamPosition,
  streamDeliveryOf
} from '../../../../renderer/src/components/terminal-pane/pty-transport/delivery/terminal-stream-position'

const grid = { cols: 80, rows: 24 }
const partial = 'prompt\r\n> \x1b[?'

function createRuntime() {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid
  })
  return runtime
}

it('restores a screen and live suffix without repainting a consumed escape continuation', async () => {
  const runtime = createRuntime()
  const continuation = '1002h\x1b[>4;2m'
  runtime.onPtyData('pty-snapshot', partial, 1)
  const pending = runtime.serializeHiddenOutputRecoveryBuffer('pty-snapshot')
  queueMicrotask(() => runtime.onPtyData('pty-snapshot', continuation, 2))
  const snapshot = await pending
  expect(snapshot).not.toBeNull()
  const restored = new HeadlessEmulator(grid)
  try {
    await restored.write(snapshot!.data)
    if (snapshot!.pendingEscapeTailAnsi) {
      await restored.write(snapshot!.pendingEscapeTailAnsi)
    }
    const position = new TerminalStreamPosition()
    position.anchor('pty-snapshot', snapshot!.seq!)
    const suffix = (partial + continuation).slice(snapshot!.seq!)
    const accepted = position.admit(
      'pty-snapshot',
      suffix,
      streamDeliveryOf(suffix, { data: continuation, seq: 25 }, { seqCountsChars: true })
    )
    if (accepted) {
      await restored.write(accepted)
    }
    expect(restored.getVisibleLines().filter(Boolean)).toEqual(['prompt', '>'])
  } finally {
    restored.dispose()
    runtime.onPtyExit('pty-snapshot', 0)
  }
})

it('preserves a seeded partial escape until completion, and retires it on Reset Terminal', async () => {
  const runtime = createRuntime()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    hasRendererSerializer: () => true,
    serializeBuffer: async () => ({ data: 'prompt\r\n> ', ...grid, seq: 13 })
  })
  runtime.onPtyData('pty-seed', partial, 1)
  const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-seed')
  expect(snapshot?.seq).toBe(13)
  const restored = new HeadlessEmulator(grid)
  try {
    await restored.write(snapshot!.data)
    await restored.write(snapshot!.pendingEscapeTailAnsi ?? '')
    await restored.write('1002h')
    expect(restored.getVisibleLines().filter(Boolean)).toEqual(['prompt', '>'])

    await runtime.resetHeadlessTerminalInputModes('pty-seed')
    const grounded = await runtime.serializeHiddenOutputRecoveryBuffer('pty-seed')
    expect(grounded?.pendingEscapeTailAnsi ?? '').toBe('')
    await restored.write(grounded!.data)
    await restored.write(grounded!.pendingEscapeTailAnsi ?? '')
    await restored.write('hello')
    expect(restored.getVisibleLines().filter(Boolean)).toEqual(['prompt', '> hello'])

    runtime.onPtyData('pty-seed', 'hello', 2)
    const live = await runtime.serializeHiddenOutputRecoveryBuffer('pty-seed')
    await restored.write(live!.data)
    expect(restored.getVisibleLines().filter(Boolean)).toEqual(['prompt', '> hello'])
  } finally {
    restored.dispose()
    runtime.onPtyExit('pty-seed', 0)
  }
})
