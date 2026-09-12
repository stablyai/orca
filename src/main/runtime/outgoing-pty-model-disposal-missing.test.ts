import { expect, it, vi } from 'vitest'
import { prepareOutgoingPtyModelDisposal } from './outgoing-pty-model-disposal'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'

function model() {
  const value = {
    emulator: { dispose: vi.fn(), disableQueryReplyForwarding: vi.fn() },
    ownership: { settle: vi.fn(async () => {}), dispose: vi.fn() },
    writeChain: Promise.resolve(),
    outputSequence: 1
  }
  return { value: value as unknown as RuntimeHeadlessTerminal, ...value }
}
function fixture() {
  const runtime = {}
  const present = model()
  const other = model()
  const models = new Map([
    ['present', present.value],
    ['other', other.value]
  ])
  fenceOutgoingPtyRegistrations(runtime, ['present', 'missing'])
  const prepare = () =>
    prepareOutgoingPtyModelDisposal(runtime, ['present', 'missing'], models, true)
  const signal = new AbortController().signal
  return { runtime, present, other, models, prepare, signal }
}

it('disposes an existing subset while retaining explicit absence and avoiding repeated side effects', async () => {
  const f = fixture()
  const cleanup = f.prepare()
  cleanup.assertCurrent()
  await cleanup.dispose(() => {}, f.signal)
  await cleanup.dispose(() => {}, f.signal)
  expect(f.models.has('present')).toBe(false)
  expect(f.models.has('missing')).toBe(false)
  expect(f.models.get('other')).toBe(f.other.value)
  expect(f.present.ownership.settle).toHaveBeenCalledOnce()
  expect(f.present.ownership.dispose).toHaveBeenCalledOnce()
  expect(f.present.emulator.disableQueryReplyForwarding).toHaveBeenCalledOnce()
  expect(f.present.emulator.dispose).toHaveBeenCalledOnce()
  expect(f.other.emulator.dispose).not.toHaveBeenCalled()
})

it('keeps default and explicit false admission strict for missing models', () => {
  const f = fixture()
  expect(() =>
    prepareOutgoingPtyModelDisposal(f.runtime, ['present', 'missing'], f.models)
  ).toThrow('model_missing')
  expect(() => prepareOutgoingPtyModelDisposal(f.runtime, ['missing'], f.models, false)).toThrow(
    'model_missing'
  )
  expect(f.present.emulator.dispose).not.toHaveBeenCalled()
})

it('requires a registration fence even when every model is already absent', async () => {
  const runtime = {}
  const models = new Map<string, RuntimeHeadlessTerminal>()
  const cleanup = prepareOutgoingPtyModelDisposal(runtime, ['missing'], models, true)
  await expect(cleanup.dispose(() => {}, new AbortController().signal)).rejects.toThrow('unfenced')
  fenceOutgoingPtyRegistrations(runtime, ['missing'])
  await cleanup.dispose(() => {}, new AbortController().signal)
  await cleanup.dispose(() => {}, new AbortController().signal)
  expect(models.size).toBe(0)
})

it('refuses a formerly absent model appearing before disposal without touching it', async () => {
  const f = fixture()
  const cleanup = f.prepare()
  f.models.set('missing', f.other.value)
  expect(cleanup.assertCurrent).toThrow('model_changed')
  await expect(cleanup.dispose(() => {}, f.signal)).rejects.toThrow('model_changed')
  expect(f.present.emulator.dispose).not.toHaveBeenCalled()
  expect(f.other.emulator.dispose).not.toHaveBeenCalled()
})

it('rechecks absence after awaiting the existing ownership settle', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  f.present.ownership.settle.mockReturnValue(pending.promise)
  const cleanup = f.prepare()
  const disposal = cleanup.dispose(() => {}, f.signal)
  await vi.waitFor(() => expect(f.present.ownership.settle).toHaveBeenCalledOnce())
  f.models.set('missing', f.other.value)
  pending.resolve()
  await expect(disposal).rejects.toThrow('model_changed')
  expect(f.present.emulator.dispose).not.toHaveBeenCalled()
  expect(f.models.get('missing')).toBe(f.other.value)
})

it.each(['reply', 'ownership', 'emulator'] as const)(
  'rechecks absence after %s disposal callbacks',
  async (stage) => {
    const f = fixture()
    const hook =
      stage === 'reply'
        ? f.present.emulator.disableQueryReplyForwarding
        : stage === 'ownership'
          ? f.present.ownership.dispose
          : f.present.emulator.dispose
    hook.mockImplementation(() => {
      f.models.set('missing', f.other.value)
    })
    const cleanup = f.prepare()
    await expect(cleanup.dispose(() => {}, f.signal)).rejects.toThrow('model_changed')
    expect(f.models.get('missing')).toBe(f.other.value)
    expect(f.other.emulator.dispose).not.toHaveBeenCalled()
    f.models.delete('missing')
    await cleanup.dispose(() => {}, f.signal)
    expect(hook).toHaveBeenCalledOnce()
  }
)

it('refuses aliasing a captured model into a previously absent slot', async () => {
  const f = fixture()
  const cleanup = f.prepare()
  f.models.set('missing', f.present.value)
  await expect(cleanup.dispose(() => {}, f.signal)).rejects.toThrow('alias_conflict')
  expect(f.present.emulator.dispose).not.toHaveBeenCalled()
})

it('refuses resurrection after successful disposal rather than adopting the replacement on retry', async () => {
  const f = fixture()
  const cleanup = f.prepare()
  await cleanup.dispose(() => {}, f.signal)
  f.models.set('missing', f.other.value)
  await expect(cleanup.dispose(() => {}, f.signal)).rejects.toThrow('model_changed')
  expect(f.present.emulator.dispose).toHaveBeenCalledOnce()
  expect(f.other.emulator.dispose).not.toHaveBeenCalled()
})
