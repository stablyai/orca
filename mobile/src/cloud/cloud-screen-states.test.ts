import { describe, expect, it } from 'vitest'
import { setCloudReturnTo, takeCloudReturnTo } from './cloud-return-to'
import { cloudHostGate, cloudMissingState, cloudNumberLinkState } from './cloud-screen-states'

const base = { isPending: false, isFetching: false, isError: false }

describe('cloud workspace screen without its workspace', () => {
  it('asks a phone that isn’t connected to sign in, instead of spinning on a query that never runs', () => {
    expect(cloudMissingState({ ...base, enrollment: null, isPending: true })).toBe('signin')
  })

  it('spins while connecting or fetching, including a retry after an error', () => {
    expect(cloudMissingState({ ...base, enrollment: undefined })).toBe('loading')
    expect(cloudMissingState({ ...base, enrollment: {}, isPending: true })).toBe('loading')
    expect(cloudMissingState({ ...base, enrollment: {}, isError: true, isFetching: true })).toBe(
      'loading'
    )
  })

  it('says Orca Cloud is unreachable on an error, and gone only when the list loaded without it', () => {
    expect(cloudMissingState({ ...base, enrollment: {}, isError: true, isPending: true })).toBe(
      'unreachable'
    )
    expect(cloudMissingState({ ...base, enrollment: {} })).toBe('gone')
  })
})

describe('cloud host gate', () => {
  const known = { enrollment: {}, isPending: false, isError: false }

  it('waits until it knows whether the host is a cloud workspace and what state it is in', () => {
    expect(cloudHostGate({ ...known, sandboxId: undefined, status: null })).toBe('wait')
    expect(cloudHostGate({ ...known, sandboxId: 'sbx', isPending: true, status: null })).toBe(
      'wait'
    )
  })

  it('shows "asleep" only for an asleep cloud workspace', () => {
    expect(cloudHostGate({ ...known, sandboxId: 'sbx', status: 'sleeping' })).toBe('asleep')
    // Still going to sleep, or awake: the page handles it.
    expect(cloudHostGate({ ...known, sandboxId: 'sbx', status: 'stopping' })).toBe('pass')
    expect(cloudHostGate({ ...known, sandboxId: 'sbx', status: 'running' })).toBe('pass')
  })

  it('passes through for desktops, an unconnected phone, or an unreachable registry', () => {
    expect(cloudHostGate({ ...known, sandboxId: null, status: null })).toBe('pass')
    expect(
      cloudHostGate({ ...known, sandboxId: 'sbx', enrollment: null, isPending: true, status: null })
    ).toBe('pass')
    expect(cloudHostGate({ ...known, sandboxId: 'sbx', isError: true, status: null })).toBe('pass')
  })
})

describe('return after connecting', () => {
  it('returns once to an in-app cloud workspace route, never anywhere else', () => {
    setCloudReturnTo('/cloud/sbx_abc')
    expect(takeCloudReturnTo()).toBe('/cloud/sbx_abc')
    expect(takeCloudReturnTo()).toBeNull()
    setCloudReturnTo('https://evil.example/cloud/x')
    expect(takeCloudReturnTo()).toBeNull()
    // Gave up on the link and connected much later: stay on Home.
    setCloudReturnTo('/cloud/sbx_abc', 0)
    expect(takeCloudReturnTo(11 * 60_000)).toBeNull()
  })

  it('returns to a W-number link too, but not to other nested paths', () => {
    setCloudReturnTo('/cloud/orca-eval-team/W-589')
    expect(takeCloudReturnTo()).toBe('/cloud/orca-eval-team/W-589')
    setCloudReturnTo('/cloud/orca-eval-team/settings')
    expect(takeCloudReturnTo()).toBeNull()
  })
})

describe('W-number link', () => {
  it('asks a phone not connected to Orca Cloud to sign in instead of calling it private or deleted', () => {
    expect(cloudNumberLinkState({ validLink: true, enrolled: false, sandboxId: null })).toBe(
      'signin'
    )
  })

  it('opens the workspace it resolves to, and is missing when it resolves to none', () => {
    expect(cloudNumberLinkState({ validLink: true, enrolled: true, sandboxId: 'sbx_1' })).toBe(
      'found'
    )
    expect(cloudNumberLinkState({ validLink: true, enrolled: true, sandboxId: null })).toBe(
      'missing'
    )
  })

  it('is missing when the link is malformed, connected or not', () => {
    expect(cloudNumberLinkState({ validLink: false, enrolled: false, sandboxId: null })).toBe(
      'missing'
    )
  })
})
