import { expect, it, vi } from 'vitest'
import {
  BASE,
  descriptorFor,
  mountOptions,
  optionsClient
} from './use-mobile-structured-agent-options.test-fixture'

it('renders trustworthy context through the phone consumer while capturing only accepted input', async () => {
  for (const declaredDefaultEffort of ['low', null, undefined]) {
    const row = {
      id: 'grok-4.7',
      label: 'Grok',
      isDefault: false,
      efforts: ['low', 'high'].map((value) => ({ value, label: value })),
      defaultEffort: 'high',
      ...(declaredDefaultEffort !== undefined ? { declaredDefaultEffort } : {})
    }
    const { client } = optionsClient(
      async () => ({
        models: [row],
        listedModelIds: [row.id],
        current: { model: row.id, defaulted: [], acceptedInputSources: { model: 'saved' } }
      }),
      async () => ({
        origin: 'probe',
        fetchedAt: 1,
        models: [row],
        listingNamesConfiguredModel: false
      })
    )
    const harness = await mountOptions({
      ...BASE,
      sessionId: `declaration-${declaredDefaultEffort}`,
      agent: 'grok',
      client,
      mutate: vi.fn(),
      sendSelection: true
    })
    expect(descriptorFor(harness.current().optionSnapshot, 'effort')).toMatchObject({
      valueSource: declaredDefaultEffort ? 'default' : 'unknown',
      kind: { currentValue: declaredDefaultEffort ?? undefined }
    })
    expect(harness.current().sendSelection()).toEqual({ selection: { model: row.id } })
    await harness.unmount()
  }
})
