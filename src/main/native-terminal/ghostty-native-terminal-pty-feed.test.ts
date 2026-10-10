import { beforeEach, describe, expect, it, vi } from 'vitest'

const writeOutput = vi.hoisted(() => vi.fn())

vi.mock('./ghostty-native-terminal-addon', () => ({
  loadGhosttyTerminalAddon: () => ({ writeOutput })
}))

import {
  bindNativeTerminalPty,
  feedNativeTerminalPtyData,
  forgetNativeTerminalSurface,
  nativeTerminalFeedDebug,
  nativeTerminalSurfacePlaced,
  reseedNativeTerminalPty,
  unbindNativeTerminalSurface,
  type NativeTerminalFeedModel,
  type NativeTerminalFeedRuntime
} from './ghostty-native-terminal-pty-feed'

function model(screen: string): NativeTerminalFeedModel {
  return {
    emulator: {
      getSnapshot: () => ({ snapshotAnsi: screen, scrollbackAnsi: '', rehydrateSequences: 'M' })
    }
  }
}

// A runtime whose write chain runs queued tasks only when flushed, like the real promise chain.
function runtime(current: NativeTerminalFeedModel | null): NativeTerminalFeedRuntime & {
  flush: () => void
} {
  const queued: ((model: NativeTerminalFeedModel) => void)[] = []
  return {
    queueHeadlessTerminalTask: (_ptyId, task) => {
      if (!current) {
        return false
      }
      queued.push(task)
      return true
    },
    flush: () => {
      for (const task of queued.splice(0)) {
        if (current) {
          task(current)
        }
      }
    }
  }
}

// What reached the addon once the batched writes of this event-loop turn flushed.
async function written(): Promise<string[]> {
  await new Promise((resolve) => setImmediate(resolve))
  return writeOutput.mock.calls.map((call: unknown[]) => String(call[1]))
}

describe('native terminal PTY feed', () => {
  beforeEach(() => {
    writeOutput.mockClear()
    forgetNativeTerminalSurface(1)
    forgetNativeTerminalSurface(2)
    nativeTerminalFeedDebug(true)
    nativeTerminalSurfacePlaced(1)
    nativeTerminalSurfacePlaced(2)
  })

  it('seeds a bound surface on the write chain, then forwards the chunks behind it', async () => {
    const live = model('SCREEN')
    const chain = runtime(live)
    expect(bindNativeTerminalPty(1, 'pty-a', chain)).toBe(true)
    // A chunk the model parsed before the seed task ran is already in its snapshot.
    chain.flush()
    expect(await written()).toEqual(['\x1bcMSCREEN'])
    feedNativeTerminalPtyData('pty-a', live, 'next')
    expect(await written()).toEqual(['\x1bcMSCREEN', 'next'])
    expect(writeOutput.mock.calls[0][0]).toBe(1)
  })

  it('batches the chunks of one event-loop turn into one write, and a seed drops them', async () => {
    const live = model('SCREEN')
    const chain = runtime(live)
    bindNativeTerminalPty(1, 'pty-batch', chain)
    chain.flush()
    feedNativeTerminalPtyData('pty-batch', live, 'a')
    feedNativeTerminalPtyData('pty-batch', live, 'b')
    expect(await written()).toEqual(['\x1bcMSCREENab'])
    feedNativeTerminalPtyData('pty-batch', live, 'stale')
    reseedNativeTerminalPty('pty-batch', live)
    feedNativeTerminalPtyData('pty-batch', live, 'c')
    expect(await written()).toEqual(['\x1bcMSCREENab', '\x1bcMSCREENc'])
  })

  it('seeds a PTY with no model yet from its first chunk', async () => {
    expect(bindNativeTerminalPty(1, 'pty-new', runtime(null))).toBe(true)
    const first = model('PROMPT')
    feedNativeTerminalPtyData('pty-new', first, 'PROMPT')
    feedNativeTerminalPtyData('pty-new', first, 'x')
    expect(await written()).toEqual(['\x1bcMPROMPTx'])
  })

  it('re-seeds once main replaces the model, and after a clear', async () => {
    const before = model('OLD')
    const chain = runtime(before)
    bindNativeTerminalPty(1, 'pty-b', chain)
    chain.flush()
    expect(await written()).toEqual(['\x1bcMOLD'])
    const after = model('RESTORED')
    feedNativeTerminalPtyData('pty-b', after, 'tail')
    expect(await written()).toEqual(['\x1bcMOLD', '\x1bcMRESTORED'])
    reseedNativeTerminalPty('pty-b', after)
    expect(await written()).toEqual(['\x1bcMOLD', '\x1bcMRESTORED', '\x1bcMRESTORED'])
  })

  it('leaves paired remote runtime PTYs, and a disabled feed, to the renderer mirror', () => {
    expect(bindNativeTerminalPty(1, 'remote:env@@h1', runtime(model('')))).toBe(false)
    nativeTerminalFeedDebug(false)
    expect(bindNativeTerminalPty(2, 'pty-c', runtime(model('')))).toBe(false)
  })

  it('waits for the surface to be placed before seeding it', async () => {
    forgetNativeTerminalSurface(1)
    const live = model('SCREEN')
    const chain = runtime(live)
    bindNativeTerminalPty(1, 'pty-p', chain)
    chain.flush()
    feedNativeTerminalPtyData('pty-p', live, 'early')
    expect(await written()).toEqual([])
    nativeTerminalSurfacePlaced(1)
    chain.flush()
    feedNativeTerminalPtyData('pty-p', live, 'late')
    expect(await written()).toEqual(['\x1bcMSCREENlate'])
  })

  it('stops feeding a surface once it is unbound or rebound', async () => {
    const live = model('S')
    const chain = runtime(live)
    bindNativeTerminalPty(1, 'pty-d', chain)
    bindNativeTerminalPty(1, 'pty-e', chain)
    chain.flush()
    feedNativeTerminalPtyData('pty-d', live, 'old pty')
    expect(await written()).toEqual(['\x1bcMS'])
    feedNativeTerminalPtyData('pty-e', live, 'gone')
    unbindNativeTerminalSurface(1)
    feedNativeTerminalPtyData('pty-e', live, 'after')
    expect(await written()).toEqual(['\x1bcMS'])
  })
})
