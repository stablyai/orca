import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, spawnProcess, getAppleSpeechHelperPath } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  spawnProcess: vi.fn(),
  getAppleSpeechHelperPath: vi.fn<() => string | null>(
    () => '/Applications/Orca.app/Contents/MacOS/orca-speech-transcriber'
  )
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess, spawnProcess }))
vi.mock('./apple-speech-helper-binary', () => ({ getAppleSpeechHelperPath }))

import { installAppleSpeechAssets, readAppleSpeechAssetStatus } from './apple-speech-assets'

type FakeHelper = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: () => void
}

function createFakeHelper(): FakeHelper {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
}

beforeEach(() => {
  runProcess.mockReset()
  spawnProcess.mockReset()
  getAppleSpeechHelperPath.mockReturnValue(
    '/Applications/Orca.app/Contents/MacOS/orca-speech-transcriber'
  )
})

describe('readAppleSpeechAssetStatus', () => {
  it('reports what the system says about the dictation language', async () => {
    runProcess.mockResolvedValue({ stdout: '{"type":"status","status":"installed"}\n' })

    await expect(readAppleSpeechAssetStatus()).resolves.toBe('installed')
  })

  it('treats an unreadable answer as unsupported rather than ready', async () => {
    runProcess.mockResolvedValue({ stdout: 'launch failed' })

    await expect(readAppleSpeechAssetStatus()).resolves.toBe('unsupported')
  })

  it('does not spawn anything when the helper is missing', async () => {
    getAppleSpeechHelperPath.mockReturnValue(null)

    await expect(readAppleSpeechAssetStatus()).resolves.toBe('unsupported')
    expect(runProcess).not.toHaveBeenCalled()
  })
})

describe('installAppleSpeechAssets', () => {
  it('reports install progress and resolves once macOS confirms', async () => {
    const helper = createFakeHelper()
    spawnProcess.mockReturnValue(helper)
    const onProgress = vi.fn()

    const install = installAppleSpeechAssets(onProgress)
    helper.stdout.write('{"type":"progress","progress":0.5}\n')
    helper.stdout.write('{"type":"installed","locale":"en-US"}\n')
    await new Promise((resolve) => setImmediate(resolve))
    helper.emit('close')

    await expect(install.completed).resolves.toBeUndefined()
    expect(onProgress).toHaveBeenCalledWith(0.5)
  })

  it('gives up when the helper pipe breaks, instead of installing forever', async () => {
    const helper = createFakeHelper()
    spawnProcess.mockReturnValue(helper)

    const install = installAppleSpeechAssets(vi.fn())
    helper.stdout.emit('error', new Error('EPIPE'))
    await new Promise((resolve) => setImmediate(resolve))
    helper.emit('close')

    await expect(install.completed).rejects.toThrow('lost the helper')
    expect(helper.kill).toHaveBeenCalled()
  })

  it('surfaces the helper error when the install never completes', async () => {
    const helper = createFakeHelper()
    spawnProcess.mockReturnValue(helper)

    const install = installAppleSpeechAssets(vi.fn())
    helper.stdout.write('{"type":"error","error":"locale_unsupported","detail":"sv-SE"}\n')
    await new Promise((resolve) => setImmediate(resolve))
    helper.emit('close')

    await expect(install.completed).rejects.toThrow('sv-SE')
  })
})
