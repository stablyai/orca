import { describe, expect, it, vi } from 'vitest'
import { runGenerationRequest } from './agent-generation-request'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import type { OnDeviceModelResult } from '../on-device-model/on-device-model-client'

const generateOnDeviceText = vi.fn(async (): Promise<OnDeviceModelResult> => ({
  ok: true,
  text: 'fix: drain the queue'
}))

vi.mock('../on-device-model/on-device-model-client', () => ({
  generateOnDeviceText: () => generateOnDeviceText()
}))

const spawnAgent = vi.fn((): never => {
  throw new Error('an agent CLI must not spawn')
})

function params(agentId: ResolvedSourceControlAiGenerationParams['agentId']) {
  return { agentId, model: 'apple-foundation-model' }
}

describe('on-device text generation routing', () => {
  it('runs the provider without planning or spawning an agent CLI', async () => {
    const result = await runGenerationRequest({
      params: params('on-device'),
      prompt: 'diff --git a/src/a.ts b/src/a.ts',
      target: { kind: 'local', cwd: '/repo' },
      operation: 'commit-message',
      spawnAgent
    })

    expect(generateOnDeviceText).toHaveBeenCalledOnce()
    expect(spawnAgent).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, rawOutput: 'fix: drain the queue' })
  })

  it('reports a missing helper instead of failing on a command template', async () => {
    generateOnDeviceText.mockResolvedValueOnce({ ok: false, kind: 'missing' })
    const result = await runGenerationRequest({
      params: params('on-device'),
      prompt: 'diff',
      target: {
        kind: 'remote',
        cwd: '/repo',
        execute: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
        missingBinaryLocation: 'orca client'
      },
      operation: 'branch-name',
      spawnAgent
    })

    expect(result).toMatchObject({ success: false, errorCode: 'onDeviceModelUnavailable' })
  })
})
