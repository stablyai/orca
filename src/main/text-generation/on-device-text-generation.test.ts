import { describe, expect, it, vi } from 'vitest'
import { ON_DEVICE_TEXT_GENERATION_CHAR_BUDGET } from '../../shared/on-device-text-generation'
import {
  ON_DEVICE_TEXT_GENERATION_LABEL,
  runOnDeviceTextGeneration
} from './on-device-text-generation'
import type { OnDeviceModelResult } from '../on-device-model/on-device-model-client'

const generate = (result: OnDeviceModelResult) => vi.fn(async () => result)

describe('runOnDeviceTextGeneration', () => {
  it('returns the model output under the on-device label', async () => {
    const result = await runOnDeviceTextGeneration({
      prompt: 'diff',
      generate: generate({ ok: true, text: 'fix: keep the queue drained' })
    })

    expect(result).toEqual({
      success: true,
      rawOutput: 'fix: keep the queue drained',
      agentLabel: ON_DEVICE_TEXT_GENERATION_LABEL
    })
  })

  it('passes user instructions as session instructions', async () => {
    const run = generate({ ok: true, text: 'ok' })
    await runOnDeviceTextGeneration({ prompt: 'diff', customPrompt: 'Be terse.', generate: run })

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'diff', instructions: 'Be terse.' })
    )
  })

  it('refuses an oversized prompt without spawning the helper', async () => {
    const run = generate({ ok: true, text: 'never' })
    const result = await runOnDeviceTextGeneration({
      prompt: 'x'.repeat(ON_DEVICE_TEXT_GENERATION_CHAR_BUDGET + 1),
      generate: run
    })

    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, errorCode: 'onDeviceModelContextExceeded' })
  })

  it.each([
    ['missing', 'onDeviceModelUnavailable'],
    ['unavailable', 'onDeviceModelUnavailable'],
    ['context', 'onDeviceModelContextExceeded'],
    ['refusal', 'onDeviceModelRefused'],
    ['locale', 'onDeviceModelLocale'],
    ['busy', 'onDeviceModelBusy']
  ] as const)('maps %s to its failure code', async (kind, errorCode) => {
    const result = await runOnDeviceTextGeneration({
      prompt: 'diff',
      generate: generate({ ok: false, kind })
    })

    expect(result).toMatchObject({ success: false, errorCode })
  })

  it('reports a timeout with the configured seconds', async () => {
    const result = await runOnDeviceTextGeneration({
      prompt: 'diff',
      generate: generate({ ok: false, kind: 'timeout' })
    })

    expect(result).toMatchObject({
      success: false,
      errorCode: 'timedOut',
      errorParams: { seconds: 60 }
    })
  })

  it('keeps the helper detail for unexpected failures', async () => {
    const result = await runOnDeviceTextGeneration({
      prompt: 'diff',
      generate: generate({ ok: false, kind: 'failed', detail: 'exit 137' })
    })

    expect(result).toMatchObject({
      success: false,
      errorCode: 'onDeviceModelFailed',
      errorDetail: 'exit 137'
    })
  })

  it('does not call the model once generation was cancelled', async () => {
    const run = generate({ ok: true, text: 'never' })
    const result = await runOnDeviceTextGeneration({
      prompt: 'diff',
      shouldExecute: () => false,
      generate: run
    })

    expect(run).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, canceled: true })
  })

  it('reports cancellation that lands mid-generation', async () => {
    const result = await runOnDeviceTextGeneration({
      prompt: 'diff',
      generate: generate({ ok: false, kind: 'canceled' })
    })

    expect(result).toMatchObject({ success: false, canceled: true })
  })
})
