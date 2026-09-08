import { expect, it } from 'vitest'
import {
  isRelayAiVaultServiceRequest,
  relayAiVaultServiceLane,
  type RelayAiVaultServiceRequest
} from './ai-vault-service-protocol'

const search = (action: 'query' | 'status' | 'configure'): RelayAiVaultServiceRequest => ({
  type: 'request',
  id: 1,
  operation: 'search',
  action,
  params: {}
})

it('keeps a history scan and a search off the lane that backs interactive reads', () => {
  expect(relayAiVaultServiceLane({ type: 'request', id: 1, operation: 'list', params: {} })).toBe(
    'cache'
  )
  expect(
    relayAiVaultServiceLane({ type: 'request', id: 1, operation: 'titles', requests: [] })
  ).toBe('interactive')
  expect(new Set([relayAiVaultServiceLane(search('query')), 'interactive']).size).toBe(2)
})

it('gives every search operation the one lane the owner serializes them on', () => {
  const lanes = new Set(
    (['query', 'status', 'configure'] as const).map((action) =>
      relayAiVaultServiceLane(search(action))
    )
  )
  expect(lanes).toEqual(new Set(['search']))
})

it('refuses a search request whose action is not one this build owns', () => {
  expect(isRelayAiVaultServiceRequest(search('query'))).toBe(true)
  expect(
    isRelayAiVaultServiceRequest({ type: 'request', id: 1, operation: 'search', params: {} })
  ).toBe(false)
  expect(
    isRelayAiVaultServiceRequest({
      type: 'request',
      id: 1,
      operation: 'search',
      action: 'drop',
      params: {}
    })
  ).toBe(false)
})
