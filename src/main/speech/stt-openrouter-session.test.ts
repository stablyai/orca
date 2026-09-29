import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelManager } from './model-manager'
import { SttService, type SttEvent } from './stt-service'

const { readKey, ready } = vi.hoisted(() => ({
  readKey: vi.fn(() => 'openrouter-key'),
  ready: vi.fn(() => true)
}))
vi.mock('./openrouter-api-key-store', () => ({
  hasOpenRouterSpeechApiKey: ready,
  readOpenRouterSpeechApiKey: readKey
}))
vi.mock('./openai-api-key-store', () => ({
  hasOpenAiSpeechApiKey: () => true,
  readOpenAiSpeechApiKey: () => 'openai-key'
}))

let modelsDir: string
beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), 'orca-openrouter-session-'))
})

afterEach(() => {
  rmSync(modelsDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  ready.mockReturnValue(true)
})

describe('OpenRouter dictation lifecycle', () => {
  it('starts without a worker, reads credentials on finish and emits the final transcript', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ text: ' MAI transcript ' }))
    vi.stubGlobal('fetch', fetchMock)
    const service = new SttService(new ModelManager(modelsDir))
    const sink = vi.fn()
    await service.startDictation('openrouter-mai-transcribe-2', sink)
    expect(service.getActiveModelId()).toBe('openrouter-mai-transcribe-2')
    expect(readKey).not.toHaveBeenCalled()
    expect(sink).toHaveBeenCalledWith({ type: 'ready' })
    service.feedAudio(new Float32Array([0.1, 0.2]), 16000)
    await service.stopDictation()
    expect(readKey).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/audio/transcriptions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer openrouter-key' })
      })
    )
    expect(sink.mock.calls.map(([event]) => event)).toEqual([
      { type: 'ready' },
      { type: 'final', text: 'MAI transcript' },
      { type: 'stopped' }
    ])
    expect(service.isActive()).toBe(false)
  })

  it('rejects an unconfigured model before recording', async () => {
    ready.mockReturnValue(false)
    const service = new SttService(new ModelManager(modelsDir))
    await expect(service.startDictation('openrouter-mai-transcribe-2', vi.fn())).rejects.toThrow(
      'Model not ready'
    )
    expect(service.isActive()).toBe(false)
  })

  it('preserves owner isolation and emits a sanitized error followed by stopped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed openrouter-key')))
    const service = new SttService(new ModelManager(modelsDir))
    const sink = vi.fn()
    await service.startDictation('openrouter-mai-transcribe-2', sink, undefined, 'mobile:1')
    expect(() => service.feedAudio(new Float32Array([0]), 16000, 'desktop')).toThrow(
      'dictation_owner_mismatch'
    )
    await expect(service.stopDictation('desktop')).rejects.toThrow('dictation_owner_mismatch')
    service.feedAudio(new Float32Array([0]), 16000, 'mobile:1')
    await service.stopDictation('mobile:1')
    expect(sink).toHaveBeenCalledWith({ type: 'error', error: 'Failed [redacted]' })
    expect(sink).toHaveBeenLastCalledWith({ type: 'stopped' })
    expect(service.isActive()).toBe(false)
  })

  it('stops an empty recording without sending audio', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const service = new SttService(new ModelManager(modelsDir))
    await service.startDictation('openrouter-mai-transcribe-2', vi.fn())
    await service.stopDictation()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(service.isActive()).toBe(false)
  })
})

describe.each(['openrouter-mai-transcribe-2', 'openai-gpt-4o-mini-transcribe'])(
  '%s session isolation',
  (modelId) => {
    it.each(['desktop', 'mobile:2'])(
      'rejects a new session from %s until the previous transcription finishes',
      async (nextOwner) => {
        const response = Promise.withResolvers<Response>()
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
        const service = new SttService(new ModelManager(modelsDir))
        const firstSink = vi.fn()
        const nextSink = vi.fn()
        await service.startDictation(modelId, firstSink)
        service.feedAudio(new Float32Array([0.1]), 16000)
        const stop = service.stopDictation()

        await expect(
          service.startDictation(modelId, nextSink, undefined, nextOwner)
        ).rejects.toThrow('dictation_already_active')
        await expect(service.stopDictation('mobile:2')).rejects.toThrow('dictation_owner_mismatch')
        response.resolve(Response.json({ text: 'first transcript' }))
        await stop
        expect(nextSink).not.toHaveBeenCalled()
        expect(firstSink.mock.calls.map(([event]) => event)).toEqual([
          { type: 'ready' },
          { type: 'final', text: 'first transcript' },
          { type: 'stopped' }
        ])

        await service.startDictation(modelId, nextSink, undefined, nextOwner)
        expect(service.getActiveModelId()).toBe(modelId)
        expect(service.isActive()).toBe(true)
        await service.stopDictation(nextOwner)
        expect(nextSink.mock.calls.map(([event]) => event)).toEqual([
          { type: 'ready' },
          { type: 'stopped' }
        ])
      }
    )

    it.each([false, true])('shares concurrent stops when the request fails: %s', async (fails) => {
      const response = Promise.withResolvers<Response>()
      const fetchMock = vi.fn().mockReturnValue(response.promise)
      vi.stubGlobal('fetch', fetchMock)
      const service = new SttService(new ModelManager(modelsDir))
      let callbackStop: Promise<void> | undefined
      const sink = vi.fn((event: SttEvent) => {
        if (event.type === 'error' || event.type === 'final') {
          callbackStop = service.stopDictation()
        }
      })
      await service.startDictation(modelId, sink)
      service.feedAudio(new Float32Array([0.1]), 16000)
      const firstStop = service.stopDictation()
      const secondStopped = vi.fn()
      const secondStop = service.stopDictation().then(secondStopped)
      await Promise.resolve()
      await Promise.resolve()
      expect(secondStopped).not.toHaveBeenCalled()

      if (fails) {
        response.reject(new Error('network unavailable'))
      } else {
        response.resolve(Response.json({ text: 'transcript' }))
      }
      await Promise.all([firstStop, secondStop])
      await callbackStop
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(sink.mock.calls.map(([event]) => event)).toEqual([
        { type: 'ready' },
        fails
          ? { type: 'error', error: 'network unavailable' }
          : { type: 'final', text: 'transcript' },
        { type: 'stopped' }
      ])
      expect(service.isActive()).toBe(false)
      await service.startDictation(modelId, vi.fn(), undefined, 'mobile:2')
      await service.stopDictation('mobile:2')
    })

    it('blocks a replacement already checking readiness when the previous session stops', async () => {
      const response = Promise.withResolvers<Response>()
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
      const manager = new ModelManager(modelsDir)
      const service = new SttService(manager)
      const sink = vi.fn()
      await service.startDictation(modelId, sink)
      service.feedAudio(new Float32Array([0.1]), 16000)

      const modelState = await manager.getModelState(modelId)
      const readiness = Promise.withResolvers<typeof modelState>()
      vi.spyOn(manager, 'getModelState').mockReturnValueOnce(readiness.promise)
      const replacementSink = vi.fn()
      const start = service.startDictation(modelId, replacementSink)
      const stop = service.stopDictation()
      readiness.resolve(modelState)
      await expect(start).rejects.toThrow('dictation_already_active')
      response.resolve(Response.json({ text: 'original transcript' }))
      await stop
      expect(replacementSink).not.toHaveBeenCalled()
      expect(sink).toHaveBeenCalledWith({ type: 'final', text: 'original transcript' })
      expect(service.isActive()).toBe(false)
    })

    it('cancels a starting session and allows a later restart', async () => {
      const manager = new ModelManager(modelsDir)
      const modelState = await manager.getModelState(modelId)
      const readiness = Promise.withResolvers<typeof modelState>()
      vi.spyOn(manager, 'getModelState').mockReturnValueOnce(readiness.promise)
      const service = new SttService(manager)
      const sink = vi.fn()
      const start = service.startDictation(modelId, sink)
      await service.stopDictation()
      readiness.resolve(modelState)
      await expect(start).rejects.toThrow('dictation_canceled')
      expect(service.isActive()).toBe(false)
      expect(sink).toHaveBeenLastCalledWith({ type: 'stopped' })
      await service.startDictation(modelId, vi.fn(), undefined, 'mobile:2')
      await service.stopDictation('mobile:2')
    })
  }
)
