import { describe, expect, it, vi } from 'vitest'
import {
  applyPiRpcSessionOption,
  PiRpcOptionObservations,
  piRpcStateOptions,
  type PiRpcOptionProof,
  type PiRpcRequester
} from './rpc-options'

const requester = (answers: Record<string, unknown>): PiRpcRequester => ({
  request: vi.fn(async (command: string) => answers[command])
})

describe('Pi launch intent adoption', () => {
  it('keeps the selector the opening dispatch compares against, and reports what Pi runs', () => {
    const proof: PiRpcOptionProof = { current: new Map(), writes: new Map() }
    const observed = new PiRpcOptionObservations(proof, () => true)
    // Pi matches `--model` by pattern, so a bare selector can start a canonical model.
    observed.adoptLaunchIntent({ model: 'sonnet', effort: 'low' })
    observed.seed({
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      thinkingLevel: 'low'
    })
    // Unchanged, so the opening submission (which carries `sonnet`) sends no set_model; that call
    // would reject the bare selector and lose the prompt.
    expect(Object.fromEntries(proof.current)).toEqual({ model: 'sonnet', effort: 'low' })
    expect(observed.read().current).toMatchObject({
      model: 'anthropic/claude-sonnet-4-5',
      effort: 'low'
    })
  })

  it('adopts nothing when the chat saved no model or effort', () => {
    const proof: PiRpcOptionProof = { current: new Map(), writes: new Map() }
    const observed = new PiRpcOptionObservations(proof, () => true)
    observed.adoptLaunchIntent(undefined)
    observed.seed({ model: { provider: 'openai-codex', id: 'gpt-5.5' } })
    expect(proof.current.size).toBe(0)
  })

  it('shows the level Pi started on when the launch selector was a pattern', () => {
    const proof: PiRpcOptionProof = { current: new Map(), writes: new Map() }
    const observed = new PiRpcOptionObservations(proof, () => true)
    observed.adoptLaunchIntent({ model: 'sonnet', effort: 'max' })
    // Pi resolved the pattern, and clamped `max` to the level this model can run.
    const state = {
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      thinkingLevel: 'high'
    }
    observed.seed(state)
    const observe = observed.prepare()
    expect(observe({ models: [], modelsKnown: false, current: piRpcStateOptions(state) })).toBe(
      true
    )
    const projected = observed.read().projectCurrent({ model: 'sonnet', effort: 'max' })
    expect(projected).toMatchObject({ model: 'anthropic/claude-sonnet-4-5', effort: 'high' })
    expect(projected.confirmed).toContain('effort')
    // The raw selector stays in the proof, so the opening dispatch still sends no set_model.
    expect(proof.current.get('model')).toBe('sonnet')
  })

  it('keeps a picker write after the launch, and reports it as current', async () => {
    const proof: PiRpcOptionProof = { current: new Map(), writes: new Map() }
    const observed = new PiRpcOptionObservations(proof, () => true)
    observed.adoptLaunchIntent({ model: 'openai-codex/gpt-5.5' })
    observed.seed({ model: { provider: 'openai-codex', id: 'gpt-5.5' } })
    await applyPiRpcSessionOption(
      requester({ set_model: {} }),
      new Map(),
      'model',
      'anthropic/claude-sonnet-4-5',
      {},
      proof
    )
    observed.seed({ model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } })
    expect(proof.current.get('model')).toBe('anthropic/claude-sonnet-4-5')
    expect(observed.read().current.model).toBe('anthropic/claude-sonnet-4-5')
  })
})
