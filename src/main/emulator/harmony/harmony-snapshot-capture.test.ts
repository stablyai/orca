import { describe, expect, it, vi } from 'vitest'
import { captureSnapshot, parseSnapshotDimensions } from './harmony-snapshot-capture'
import type { HarmonyCommandResult, HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

const paths = { remote: '/data/local/tmp/x.jpeg', local: '/tmp/x.jpeg' }

describe('parseSnapshotDimensions', () => {
  it('parses width/height', () => {
    expect(parseSnapshotDimensions('success as jpeg, width: 1280, height: 2832')).toEqual({
      width: 1280,
      height: 2832
    })
  })

  it('returns null without dimensions', () => {
    expect(parseSnapshotDimensions('failure')).toBeNull()
  })
})

describe('captureSnapshot', () => {
  const snapshotStdout = 'success: saved as jpeg, width: 1280, height: 2832'

  function runnerFor(
    result: HarmonyCommandResult,
    match: (args: readonly string[]) => boolean
  ): HarmonyCommandRunner {
    return vi.fn<HarmonyCommandRunner>(async (_binary, args) =>
      match(args) ? result : { stdout: '', stderr: '', code: 0 }
    )
  }

  it('captures, pulls and reads the JPEG with dimensions', async () => {
    const jpeg = Buffer.from([0xff, 0xd8])
    const run = vi.fn<HarmonyCommandRunner>(async (_binary, args) => {
      const command = args.join(' ')
      if (command.includes('snapshot_display')) {
        return { stdout: snapshotStdout, stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const readFile = vi.fn(async () => jpeg)

    const result = await captureSnapshot(run, SDK, '127.0.0.1:5555', paths, { readFile })

    expect(result).toEqual({ jpeg, size: { width: 1280, height: 2832 } })
    expect(run).toHaveBeenCalledWith(SDK.hdc, [
      '-t',
      '127.0.0.1:5555',
      'file',
      'recv',
      paths.remote,
      paths.local
    ])
  })

  it('throws when dimensions are missing', async () => {
    const run = runnerFor({ stdout: 'saved without dims', stderr: '', code: 0 }, (args) =>
      args.includes('snapshot_display')
    )
    await expect(
      captureSnapshot(run, SDK, '127.0.0.1:5555', paths, {
        readFile: vi.fn()
      })
    ).rejects.toThrow('snapshot_display did not report frame dimensions.')
  })

  it('throws when recv fails', async () => {
    const run = vi.fn<HarmonyCommandRunner>(async (_binary, args) => {
      if (args.includes('snapshot_display')) {
        return { stdout: snapshotStdout, stderr: '', code: 0 }
      }
      return { stdout: '', stderr: 'recv error', code: 1 }
    })
    await expect(
      captureSnapshot(run, SDK, '127.0.0.1:5555', paths, {
        readFile: vi.fn()
      })
    ).rejects.toThrow('snapshot recv failed: recv error')
  })
})
