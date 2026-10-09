import { describe, expect, it, vi } from 'vitest'
import { HarmonyStreamController } from './harmony-stream-controller'
import type { EmulatorSessionInfo } from '../emulator-types'
import type { HarmonyStreamHandle, StartHarmonyStream } from './harmony-stream-session-starter'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

const runner = vi.fn<HarmonyCommandRunner>()

function infoFor(key: string): EmulatorSessionInfo {
  return {
    deviceUdid: key,
    wsUrl: '',
    streamUrl: `http://127.0.0.1:1/stream.mjpeg`,
    streamCodec: 'mjpeg',
    backend: 'harmonyos'
  }
}

describe('HarmonyStreamController', () => {
  it('dedupes concurrent starts to one session per target', async () => {
    let resolveStart: (value: {
      info: EmulatorSessionInfo
      handle: HarmonyStreamHandle
    }) => void = () => {}
    const startStreamSession = vi.fn<StartHarmonyStream>(
      () =>
        new Promise<{ info: EmulatorSessionInfo; handle: HarmonyStreamHandle }>((resolve) => {
          resolveStart = resolve
        })
    )

    const controller = new HarmonyStreamController({
      startStreamSession,
      runner,
      sdk: () => SDK,
      frameIntervalMs: 15
    })

    const first = controller.start('127.0.0.1:5555')
    const second = controller.start('127.0.0.1:5555')

    const close = vi.fn()
    resolveStart({ info: infoFor('127.0.0.1:5555'), handle: { close } })

    const [infoA, infoB] = await Promise.all([first, second])
    expect(infoA).toBe(infoB)
    expect(startStreamSession).toHaveBeenCalledTimes(1)
    expect(controller.has('127.0.0.1:5555')).toBe(true)

    // A later start reuses the cached entry without starting again.
    await controller.start('127.0.0.1:5555')
    expect(startStreamSession).toHaveBeenCalledTimes(1)
  })

  it('stops a session and allows a fresh start afterwards', async () => {
    const close = vi.fn()
    const startStreamSession = vi.fn<StartHarmonyStream>(async () => ({
      info: infoFor('127.0.0.1:5555'),
      handle: { close }
    }))

    const controller = new HarmonyStreamController({
      startStreamSession,
      runner,
      sdk: () => SDK
    })

    await controller.start('127.0.0.1:5555')
    controller.stop('127.0.0.1:5555')
    expect(close).toHaveBeenCalledTimes(1)
    expect(controller.has('127.0.0.1:5555')).toBe(false)

    await controller.start('127.0.0.1:5555')
    expect(startStreamSession).toHaveBeenCalledTimes(2)
  })
})
