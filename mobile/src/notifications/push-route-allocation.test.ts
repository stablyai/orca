import {
  createRouteDeclarationFixture,
  routeDeclarationPorts,
  hosts,
  requests,
  settle
} from './push-route-declaration-ports.test-fixture'
import { expect, it } from 'vitest'
import { PushRouteDeclarationSchema } from '../../../cloud/packages/push-contract/src/route-declaration'

const fixture = createRouteDeclarationFixture()
const state = routeDeclarationPorts()

it('rederives current P after a lost proposal, issued prune, re-add, lost acceptance and restart', async () => {
  hosts(100)
  const { bodies, operations, send, respond } = requests()
  const store = await import('../transport/host-store')
  const metadata = await import('../transport/host-metadata-store')
  const registration = await import('./push-registration')
  await fixture.register()
  const prior = bodies.at(-1)
  const first = (await metadata.readStoredHostProfilesForMutation()).at(0)
  if (!prior || !first) {
    throw new Error('Missing actual initial allocation')
  }
  const paired = { ...first, deviceToken: 'controlled-pairing-token' }
  let loseProposal = true
  send.mockImplementation(async (_url, init) => {
    const value = PushRouteDeclarationSchema.parse(JSON.parse(String(init?.body)))
    if (value.action === 'replace' && loseProposal) {
      loseProposal = false
      throw new Error('proposal did not reach gateway')
    }
    return respond(init)
  })
  await store.removeHost(first.id)
  await settle()
  const savedBeforeIssue = Number(state.storage.get('orca:push-route-version'))
  expect(savedBeforeIssue).toBeGreaterThan(prior.version)
  await store.savePairedHost(paired) // re-add before the lost proposal can prune P
  await settle()
  expect(bodies.at(-1)?.hosts).toEqual(prior.hosts)
  expect(bodies.at(-1)?.version).toBeGreaterThan(savedBeforeIssue)
  const gate = Promise.withResolvers<void>()
  const issued = Promise.withResolvers<void>()
  let hold = true
  send.mockImplementation(async (_url, init) => {
    const value = PushRouteDeclarationSchema.parse(JSON.parse(String(init?.body)))
    if (hold && value.action === 'replace') {
      hold = false
      issued.resolve()
      await gate.promise
      const committed = respond(init)
      expect(committed.status).toBe(200) // old issued primitive may commit after retirement
      throw new Error('committed prune reply lost')
    }
    return respond(init)
  })
  try {
    await store.removeHost(first.id)
    await settle()
    await issued.promise
    const pending = operations.length
    await store.savePairedHost(paired) // local action finishes while old physical POST is held
    await settle()
    expect(operations).toHaveLength(pending)
    fixture.stop?.()
    fixture.stop = registration.startPushTokenSync()
    await settle()
    expect(operations).toHaveLength(pending)
    gate.resolve()
    await settle()
    expect(bodies.at(-1)?.hosts).toEqual(prior.hosts)
    const pruned = bodies.at(-2)
    expect(pruned?.hosts).toHaveLength(99)
    expect(bodies.at(-1)?.expectedVersion).toBe(pruned?.version)
    expect(bodies.at(-1)?.version).toBeGreaterThan(pruned?.version ?? 0)
  } finally {
    gate.resolve()
    await settle()
  }
})

it('treats restored invalid-to-valid and in-place changed keys as new identities without evicting retained members', async () => {
  hosts(102)
  const metadata = await import('../transport/host-metadata-store')
  const profiles = await metadata.readStoredHostProfilesForMutation()
  const first = profiles.at(0)
  const recovered = profiles.at(-1)
  if (!first || !recovered) {
    throw new Error('Missing restored rows')
  }
  state.storage.set(
    'orca:hosts',
    JSON.stringify(
      profiles
        .map((row) => (row === recovered ? { ...row, publicKeyB64: 'unreadable' } : row))
        .slice(1)
    )
  )
  const { bodies, send } = requests()
  await fixture.register()
  const prior = bodies.at(-1)
  if (!prior) {
    throw new Error('Missing restored P100')
  }
  expect(prior.hosts).toHaveLength(100)
  const store = await import('../transport/host-store')
  await store.savePairedHost({ ...recovered, deviceToken: 'recovered-key' })
  await settle()
  expect(bodies.at(-1)?.hosts).toEqual(prior.hosts) // valid new identity refused as a whole
  const changed = profiles.at(1)
  if (!changed) {
    throw new Error('Missing changed row')
  }
  await store.savePairedHost({
    ...changed,
    publicKeyB64: first.publicKeyB64,
    deviceToken: 'changed-key'
  })
  await settle()
  expect(bodies.at(-1)?.hosts).toHaveLength(99)
  expect(bodies.at(-1)?.hosts.every((host) => prior.hosts.includes(host))).toBe(true)
  const before = send.mock.calls.length
  await store.removeHost(recovered.id) // remaining complete batch now fits
  await settle()
  expect(bodies.at(-1)?.hosts).toHaveLength(100)
  expect(send).toHaveBeenCalledTimes(before + 2)
})
