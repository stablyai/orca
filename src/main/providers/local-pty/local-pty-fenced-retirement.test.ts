import { expect, it } from 'vitest'
import { LocalPtyProvider } from './local-pty-provider'
import { exitedLocalPtyIncarnations, recordLocalPtyExit } from './local-pty-provider-state'

const original = {
  id: 'local-terminated-restart-fixture',
  expectedIncarnationId: 'known-incarnation',
  requireNoAgentOwner: false,
  requireUnattached: false
}

it('proves local retirement only for an incarnation that actually exited here', async () => {
  const provider = new LocalPtyProvider()
  await expect(provider.killFenced(original)).resolves.toEqual({
    outcome: 'refused',
    reason: 'unverifiable'
  })
  recordLocalPtyExit(original.id, original.expectedIncarnationId)
  try {
    await expect(provider.killFenced(original)).resolves.toEqual({ outcome: 'already_exited' })
    await expect(
      provider.killFenced({ ...original, expectedIncarnationId: 'different-incarnation' })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
  } finally {
    exitedLocalPtyIncarnations.delete(original.id)
  }
})

it('only advertises local termination for requests whose conditions the provider can prove', () => {
  const provider = new LocalPtyProvider()
  expect(provider.supportsFencedTermination(original.id)).toBe(false)
  expect(provider.supportsFencedTermination(original.id, original)).toBe(true)
  expect(
    provider.supportsFencedTermination(original.id, { ...original, requireUnattached: true })
  ).toBe(false)
  expect(
    provider.supportsFencedTermination(original.id, { ...original, requireNoAgentOwner: true })
  ).toBe(false)
})
