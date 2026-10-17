import { afterEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

import { speechApi } from './speech-bridge'

describe('speech preload bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    invoke.mockClear()
  })

  it('sends dictation audio as its bytes without the Buffer global', async () => {
    // Electron 45 sandboxed preloads have no Buffer.
    vi.stubGlobal('Buffer', undefined)
    const frame = new Float32Array([9, 0.5, -0.25, 1])

    await speechApi.feedAudio(frame.subarray(1), 16000, 'desktop:1')

    const [channel, bytes, sampleRate, sessionId] = invoke.mock.calls[0]
    expect([channel, sampleRate, sessionId]).toEqual(['speech:feedAudio', 16000, 'desktop:1'])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect([...new Float32Array(bytes.slice().buffer)]).toEqual([0.5, -0.25, 1])
  })
})
