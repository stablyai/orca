import { describe, expect, it } from 'vitest'
import { SECRET_REQUEST_ERRORS } from '../../../shared/secret-request-contract'
import {
  phoneSecretRequestEvent,
  SecretRequestError,
  SecretRequestStore,
  type SecretRequestInput,
  type SecretRequestStoreEvent
} from './secret-request-store'

const MIN = 60_000

function makeStore() {
  const clock = { now: 1_000_000 }
  let seq = 0
  const store = new SecretRequestStore(
    () => clock.now,
    () => `sr_test${String(++seq).padStart(4, '0')}`
  )
  const events: SecretRequestStoreEvent[] = []
  store.subscribe((event) => events.push(event))
  return { store, clock, events }
}

function input(name: string, extra: Partial<SecretRequestInput> = {}): SecretRequestInput {
  return {
    name,
    reason: 'Run the integration tests',
    agent: 'claude',
    worktreeId: 'wt-1',
    terminalHandle: 'term-1',
    sessionEnvNames: new Set(),
    ...extra
  }
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof SecretRequestError ? error.code : undefined
  }
  return undefined
}

describe('SecretRequestStore', () => {
  it('queues a request, announces it and defaults the scope to personal', () => {
    const { store, events } = makeStore()
    expect(store.request(input('STRIPE_KEY', { scope: undefined }))).toEqual({
      requestId: 'sr_test0001',
      status: 'pending'
    })
    expect(events).toEqual([
      {
        type: 'secrets.requested',
        requestId: 'sr_test0001',
        name: 'STRIPE_KEY',
        reason: 'Run the integration tests',
        scope: 'personal',
        agent: 'claude',
        worktreeId: 'wt-1',
        terminalHandle: 'term-1',
        requestedAt: 1_000_000,
        expiresAt: 1_000_000 + 15 * MIN
      }
    ])
    expect(store.status('sr_test0001')).toMatchObject({ status: 'pending', name: 'STRIPE_KEY' })
  })

  it('answers already-set without queueing when the session env has the name', () => {
    const { store, events } = makeStore()
    expect(
      store.request(input('SENTRY_DSN', { sessionEnvNames: new Set(['SENTRY_DSN']) }))
    ).toEqual({ requestId: null, status: 'already-set' })
    expect(events).toEqual([])
    expect(store.pendingEvents()).toEqual([])
  })

  it.each([
    ['lower_case', SECRET_REQUEST_ERRORS.invalidName],
    ['1STARTS_WITH_DIGIT', SECRET_REQUEST_ERRORS.invalidName],
    ['A'.repeat(129), SECRET_REQUEST_ERRORS.invalidName],
    ['CLAUDE_CODE_OAUTH_TOKEN', SECRET_REQUEST_ERRORS.subscriptionTokenRefused],
    ['PATH', SECRET_REQUEST_ERRORS.reservedName],
    ['GITHUB_TOKEN', SECRET_REQUEST_ERRORS.reservedName],
    ['ORCA_ANYTHING', SECRET_REQUEST_ERRORS.reservedName],
    ['LD_PRELOAD', SECRET_REQUEST_ERRORS.reservedName],
    ['GIT_CONFIG_GLOBAL', SECRET_REQUEST_ERRORS.reservedName],
    ['ANTHROPIC_API_KEY', SECRET_REQUEST_ERRORS.agentCredential],
    ['AWS_BEARER_TOKEN_BEDROCK', SECRET_REQUEST_ERRORS.agentCredential],
    ['OPENAI_BASE_URL', SECRET_REQUEST_ERRORS.agentCredential]
  ])('refuses %s with %s', (name, code) => {
    const { store, events } = makeStore()
    expect(errorCode(() => store.request(input(name)))).toBe(code)
    expect(events).toEqual([])
  })

  it('still allows names that are not agent credentials (AI_GATEWAY_API_KEY, general AWS_*)', () => {
    const { store } = makeStore()
    expect(store.request(input('AI_GATEWAY_API_KEY')).status).toBe('pending')
    expect(store.request(input('AWS_SECRET_ACCESS_KEY')).status).toBe('pending')
  })

  it('dedupes the same name while pending, without a second card', () => {
    const { store, events } = makeStore()
    const first = store.request(input('DB_URL'))
    const again = store.request(input('DB_URL', { reason: 'different words' }))
    expect(again).toEqual(first)
    expect(events).toHaveLength(1)
  })

  it('allows at most 3 pending requests', () => {
    const { store } = makeStore()
    for (const name of ['A1', 'A2', 'A3']) {
      store.request(input(name))
    }
    expect(errorCode(() => store.request(input('A4')))).toBe(SECRET_REQUEST_ERRORS.tooManyPending)
    // Answering one frees a slot.
    store.resolve('sr_test0001', 'declined')
    expect(store.request(input('A4')).status).toBe('pending')
  })

  it('allows at most 10 requests per hour, counting answered ones', () => {
    const { store, clock } = makeStore()
    for (let i = 0; i < 10; i += 1) {
      const { requestId } = store.request(input(`N${i}`))
      if (!requestId) {
        throw new Error('expected a queued request')
      }
      store.resolve(requestId, 'provided')
      clock.now += MIN
    }
    expect(errorCode(() => store.request(input('N10')))).toBe(SECRET_REQUEST_ERRORS.rateLimited)
    // The first falls out of the hour window.
    clock.now = 1_000_000 + 60 * MIN
    expect(store.request(input('N10')).status).toBe('pending')
  })

  it('expires pending requests after 15 minutes and stops replaying them', () => {
    const { store, clock } = makeStore()
    store.request(input('TOKEN'))
    clock.now += 15 * MIN - 1
    expect(store.pendingEvents()).toHaveLength(1)
    clock.now += 1
    expect(store.status('sr_test0001').status).toBe('expired')
    expect(store.pendingEvents()).toEqual([])
    // An expired request frees its name and slot.
    expect(store.request(input('TOKEN')).requestId).toBe('sr_test0002')
  })

  it('touch extends to now + 15 minutes, capped at 60 minutes after the request', () => {
    const { store, clock } = makeStore()
    store.request(input('TOKEN'))
    clock.now += 10 * MIN
    expect(store.touch('sr_test0001')).toEqual({ expiresAt: clock.now + 15 * MIN })
    for (let i = 0; i < 4; i += 1) {
      clock.now += 10 * MIN
      store.touch('sr_test0001')
    }
    // 60 minutes after the request, however often it was touched.
    expect(store.status('sr_test0001').expiresAt).toBe(1_000_000 + 60 * MIN)
    clock.now = 1_000_000 + 60 * MIN
    expect(store.status('sr_test0001').status).toBe('expired')
    expect(errorCode(() => store.touch('sr_test0001'))).toBe(SECRET_REQUEST_ERRORS.notPending)
  })

  it('resolves once; a request that expired mid-save reports expired', () => {
    const { store, clock, events } = makeStore()
    store.request(input('A'))
    store.request(input('B'))
    expect(store.resolve('sr_test0001', 'provided')).toEqual({ outcome: 'provided' })
    expect(store.resolve('sr_test0001', 'declined')).toEqual({ outcome: 'provided' })
    expect(store.status('sr_test0001').status).toBe('provided')
    clock.now += 16 * MIN
    expect(store.resolve('sr_test0002', 'provided')).toEqual({ outcome: 'expired' })
    expect(events.filter((e) => e.type === 'secrets.requestSettled')).toEqual([
      { type: 'secrets.requestSettled', requestId: 'sr_test0001', status: 'provided' }
    ])
  })

  it('reports unknown ids, and forgets old ones', () => {
    const { store, clock } = makeStore()
    expect(errorCode(() => store.status('sr_missing00'))).toBe(SECRET_REQUEST_ERRORS.notFound)
    store.request(input('A'))
    clock.now += 2 * 60 * MIN
    expect(errorCode(() => store.status('sr_test0001'))).toBe(SECRET_REQUEST_ERRORS.notFound)
  })

  it('gives phones status only: no reason or terminal handle', () => {
    const { store, events } = makeStore()
    store.request(input('A'))
    const event = events[0]
    const phone = phoneSecretRequestEvent(event)
    expect(phone).not.toHaveProperty('reason')
    expect(phone).not.toHaveProperty('terminalHandle')
    expect(phone).toMatchObject({ name: 'A', agent: 'claude', requestId: event.requestId })
  })
})
