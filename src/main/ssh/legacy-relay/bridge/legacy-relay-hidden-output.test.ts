import { expect, it } from 'vitest'
import { LegacyRelayHiddenOutput } from './legacy-relay-hidden-output'

it('replays a renderer-reported gap on reveal even when the relay dropped no new output', () => {
  const delivered: string[] = []
  const hiddenOutput = new LegacyRelayHiddenOutput({
    onReplay: (_id, data) => delivered.push(data),
    onData: (_id, data) => delivered.push(data),
    reread: async (_id, atSnapshot) => atSnapshot('recovered screen')
  })

  hiddenOutput.setPaused('session', true, true)
  hiddenOutput.setPaused('session', false)
  hiddenOutput.onData('session', 'new output')

  expect(delivered).toEqual(['recovered screen', 'new output'])
})
