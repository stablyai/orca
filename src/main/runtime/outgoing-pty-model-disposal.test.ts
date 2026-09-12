import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { prepareOutgoingPtyModelDisposal } from './outgoing-pty-model-disposal'
import { fenceOutgoingPtyRegistrations } from './outgoing-pty-registration-fence'

class Runtime extends OrcaRuntimeService {
  models() {
    return this.headlessTerminals
  }
}
async function fixture() {
  const runtime = new Runtime()
  for (const id of ['source', 'second', 'other']) {
    await runtime.acceptPtyDataBounded(id, 'retained\r\n', Date.now()).completion
  }
  const prepare = () =>
    prepareOutgoingPtyModelDisposal(runtime, ['source', 'second'], runtime.models())
  return { runtime, prepare, signal: new AbortController().signal }
}

it('disposes only settled fenced source models without process exit and is repeat-safe', async () => {
  const { runtime, prepare, signal } = await fixture()
  const source = runtime.models().get('source')!
  const other = runtime.models().get('other')!
  const dispose = vi.spyOn(source.emulator, 'dispose')
  const disable = vi.spyOn(source.emulator, 'disableQueryReplyForwarding')
  const exit = vi.spyOn(runtime, 'onPtyExit')
  const cleanup = prepare()
  fenceOutgoingPtyRegistrations(runtime, ['source', 'second'])
  await cleanup.dispose(() => {}, signal)
  await cleanup.dispose(() => {}, signal)
  expect(runtime.models().has('source')).toBe(false)
  expect(runtime.models().has('second')).toBe(false)
  expect(runtime.models().get('other')).toBe(other)
  expect(disable).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
  expect(disable.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0])
  expect(exit).not.toHaveBeenCalled()
})

it('requires both source fences and current authority before any model disposal', async () => {
  const { runtime, prepare, signal } = await fixture()
  const cleanup = prepare()
  const dispose = vi.spyOn(runtime.models().get('source')!.emulator, 'dispose')
  fenceOutgoingPtyRegistrations(runtime, ['source'])
  await expect(cleanup.dispose(() => {}, signal)).rejects.toThrow('disposal_unfenced')
  fenceOutgoingPtyRegistrations(runtime, ['second'])
  await expect(
    cleanup.dispose(() => {
      throw new Error('authority lost')
    }, signal)
  ).rejects.toThrow('authority lost')
  expect(dispose).not.toHaveBeenCalled()
  expect(runtime.models().size).toBe(3)
})

it('settles the entire cohort and rejects replacement during a pending ownership wait', async () => {
  const { runtime, prepare, signal } = await fixture()
  const second = runtime.models().get('second')!
  const pending = Promise.withResolvers<void>()
  const settle = vi.spyOn(second.ownership, 'settle').mockReturnValue(pending.promise)
  const dispose = vi.spyOn(runtime.models().get('source')!.emulator, 'dispose')
  const cleanup = prepare()
  fenceOutgoingPtyRegistrations(runtime, ['source', 'second'])
  const completion = cleanup.dispose(() => {}, signal)
  await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
  expect(dispose).not.toHaveBeenCalled()
  await expect(cleanup.dispose(() => {}, signal)).rejects.toThrow('disposal_busy')
  runtime.models().set('second', runtime.models().get('other')!)
  const refused = expect(completion).rejects.toThrow('source_model_changed')
  pending.resolve()
  await refused
  expect(dispose).not.toHaveBeenCalled()
})

it('retries failed disposal without repeating a successfully disposed model', async () => {
  const { runtime, prepare, signal } = await fixture()
  const sourceDispose = vi.spyOn(runtime.models().get('source')!.emulator, 'dispose')
  const second = runtime.models().get('second')!
  const ownershipDispose = vi.spyOn(second.ownership, 'dispose')
  const ownershipSettle = vi.spyOn(second.ownership, 'settle')
  const disable = vi.spyOn(second.emulator, 'disableQueryReplyForwarding')
  const secondDispose = vi.spyOn(second.emulator, 'dispose').mockImplementationOnce(() => {
    throw new Error('disposal failed')
  })
  const cleanup = prepare()
  fenceOutgoingPtyRegistrations(runtime, ['source', 'second'])
  await expect(cleanup.dispose(() => {}, signal)).rejects.toThrow('disposal failed')
  expect(runtime.models().has('source')).toBe(false)
  expect(runtime.models().get('second')).toBe(second)
  await cleanup.dispose(() => {}, signal)
  expect(sourceDispose).toHaveBeenCalledOnce()
  expect(secondDispose).toHaveBeenCalledTimes(2)
  expect(ownershipDispose).toHaveBeenCalledOnce()
  expect(ownershipSettle).toHaveBeenCalledOnce()
  expect(disable).toHaveBeenCalledOnce()
  expect(runtime.models().has('second')).toBe(false)
})

it('refuses resurrected models on repeat rather than disposing their replacements', async () => {
  const { runtime, prepare, signal } = await fixture()
  const cleanup = prepare()
  fenceOutgoingPtyRegistrations(runtime, ['source', 'second'])
  await cleanup.dispose(() => {}, signal)
  const replacement = runtime.models().get('other')!
  runtime.models().set('source', replacement)
  await expect(cleanup.dispose(() => {}, signal)).rejects.toThrow('source_model_changed')
  expect(runtime.models().get('source')).toBe(replacement)
})

it.each(['reply-forwarding', 'ownership'] as const)(
  'rechecks authority after %s disposal and resumes without repeating the completed stage',
  async (stage) => {
    const { runtime, prepare, signal } = await fixture()
    const model = runtime.models().get('source')!
    let lost = false
    const originalDisable = model.emulator.disableQueryReplyForwarding.bind(model.emulator)
    const originalOwnershipDispose = model.ownership.dispose.bind(model.ownership)
    const disable = vi
      .spyOn(model.emulator, 'disableQueryReplyForwarding')
      .mockImplementation(() => {
        originalDisable()
        if (stage === 'reply-forwarding') {
          lost = true
        }
      })
    const ownership = vi.spyOn(model.ownership, 'dispose').mockImplementation(() => {
      originalOwnershipDispose()
      if (stage === 'ownership') {
        lost = true
      }
    })
    const dispose = vi.spyOn(model.emulator, 'dispose')
    const cleanup = prepare()
    fenceOutgoingPtyRegistrations(runtime, ['source', 'second'])
    await expect(
      cleanup.dispose(() => {
        if (lost) {
          throw new Error('authority lost between stages')
        }
      }, signal)
    ).rejects.toThrow('authority lost between stages')
    expect(dispose).not.toHaveBeenCalled()
    expect(ownership).toHaveBeenCalledTimes(stage === 'ownership' ? 1 : 0)
    expect(runtime.models().get('source')).toBe(model)
    await cleanup.dispose(() => {}, signal)
    expect(disable).toHaveBeenCalledOnce()
    expect(ownership).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(runtime.models().has('source')).toBe(false)
  }
)

it.each(['emulator', 'ownership'] as const)(
  'refuses replaced or aliased %s components',
  async (field) => {
    const { runtime, prepare, signal } = await fixture()
    const source = runtime.models().get('source')!
    const original = source[field]
    const cleanup = prepare()
    Object.assign(source, { [field]: runtime.models().get('other')![field] })
    fenceOutgoingPtyRegistrations(runtime, ['source', 'second'])
    await expect(cleanup.dispose(() => {}, signal)).rejects.toThrow('source_model_changed')
    Object.assign(source, { [field]: original })
    runtime.models().set('foreign-alias', { ...runtime.models().get('other')!, [field]: original })
    await expect(cleanup.dispose(() => {}, signal)).rejects.toThrow('source_model_alias_conflict')
    expect(runtime.models().get('source')).toBe(source)
  }
)

it.each(['prepare', 'dispose'] as const)(
  'refuses a foreign model alias during %s',
  async (phase) => {
    const { runtime, prepare, signal } = await fixture()
    const source = runtime.models().get('source')!
    const dispose = vi.spyOn(source.emulator, 'dispose')
    const cleanup = phase === 'dispose' ? prepare() : null
    runtime.models().set('foreign-alias', source)
    fenceOutgoingPtyRegistrations(runtime, ['source', 'second'])
    if (cleanup) {
      await expect(cleanup.dispose(() => {}, signal)).rejects.toThrow('source_model_alias_conflict')
    } else {
      expect(prepare).toThrow('source_model_alias_conflict')
    }
    expect(dispose).not.toHaveBeenCalled()
    expect(runtime.models().get('source')).toBe(source)
  }
)
