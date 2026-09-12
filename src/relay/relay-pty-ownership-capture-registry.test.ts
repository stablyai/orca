import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipCaptureRegistry } from './relay-pty-ownership-capture-registry'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import { context, identity } from './relay-pty-ownership-transfer-delegation-test-fixture'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(['expiry', 'detach', 'dispose'])(
  'revokes every capture despite failed %s cleanup',
  (mode) => {
    const log = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const release = vi.fn(() => {
      throw new Error('resume failed')
    })
    const registry = new RelayPtyOwnershipCaptureRegistry(() => ({ inspect: () => null, release }))
    const owner = context(1, 2)
    const tokens = ['first', 'second'].map((request) => registry.begin(identity, request, owner))
    expect(() => {
      if (mode === 'expiry') {
        vi.advanceTimersByTime(5_000)
      } else if (mode === 'detach') {
        registry.detach(owner.clientId)
      } else {
        registry.dispose()
      }
    }).not.toThrow()
    expect(release).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(log).toHaveBeenCalledTimes(2)
    for (const token of tokens) {
      expect(() => registry.inspect(token, owner)).toThrow('unavailable')
    }
    registry.dispose()
    expect(release).toHaveBeenCalledTimes(2)
  }
)

it('reports explicit release failure instead of acknowledging successful cleanup', () => {
  const fixture = setup()
  fixture.capture.release.mockImplementation(() => {
    throw new Error('resume failed')
  })
  expect(() => fixture.registry.release(fixture.token, fixture.owner)).toThrow('resume failed')
  expect(() => fixture.registry.inspect(fixture.token, fixture.owner)).toThrow('unavailable')
  expect(vi.getTimerCount()).toBe(0)
})
function setup() {
  const capture = { inspect: vi.fn(() => null), release: vi.fn() }
  const begin = vi.fn(() => capture)
  const select = vi.fn<RelayPtyOwnershipTransferAdapter['selectCaptureBaseline']>()
  const registry = new RelayPtyOwnershipCaptureRegistry(begin, select)
  const owner = context(1, 2)
  const token = registry.begin(identity, 'request', owner)
  return { capture, begin, select, registry, owner, token }
}

it('reuses an exact request without reacquiring or extending its capture', () => {
  const fixture = setup()
  vi.advanceTimersByTime(4_000)
  expect(fixture.registry.begin(identity, 'request', fixture.owner)).toBe(fixture.token)
  expect(fixture.begin).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(1_000)
  expect(fixture.capture.release).toHaveBeenCalledOnce()
  expect(() => fixture.registry.inspect(fixture.token, fixture.owner)).toThrow('unavailable')
})

it('refuses changed identity on request retry', () => {
  const fixture = setup()
  expect(() =>
    fixture.registry.begin({ ...identity, incarnationId: 'other' }, 'request', fixture.owner)
  ).toThrow('conflict')
  fixture.registry.dispose()
})

it.each(['client', 'transport', 'principal', 'stale'])(
  'refuses %s token reuse without inspecting or releasing the owner capture',
  (mode) => {
    const fixture = setup()
    const other = context(mode === 'client' ? 2 : 1, mode === 'transport' ? 3 : 2)
    if (mode === 'principal') {
      other.sessionIdentity = { ...other.sessionIdentity!, principal: 'different' }
    }
    if (mode === 'stale') {
      other.isStale = () => true
    }
    expect(() => fixture.registry.inspect(fixture.token, other)).toThrow('unavailable')
    expect(() => fixture.registry.release(fixture.token, other)).toThrow('unavailable')
    expect(() => fixture.registry.select(fixture.token, {}, other)).toThrow('unavailable')
    expect(fixture.select).not.toHaveBeenCalled()
    expect(fixture.capture.inspect).not.toHaveBeenCalled()
    expect(fixture.capture.release).not.toHaveBeenCalled()
    fixture.registry.dispose()
  }
)

it('releases on owner detach and leaves another client alone', () => {
  const fixture = setup()
  fixture.registry.detach(2)
  fixture.registry.inspect(fixture.token, fixture.owner)
  expect(fixture.capture.inspect).toHaveBeenCalledOnce()
  fixture.registry.detach(1)
  expect(fixture.capture.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  expect(() => fixture.registry.inspect(fixture.token, fixture.owner)).toThrow('unavailable')
})

it('binds selection to the token identity and rechecks token authority inside its inspector', () => {
  const fixture = setup()
  const value = { boundary: 'caller data' }
  fixture.registry.select(fixture.token, value, fixture.owner)
  expect(fixture.select).toHaveBeenCalledWith(identity, value, expect.any(Function))
  const inspect = fixture.select.mock.calls[0][2]
  expect(inspect()).toBeNull()
  fixture.registry.detach(fixture.owner.clientId)
  expect(inspect).toThrow('unavailable')
  expect(() => fixture.registry.select(fixture.token, value, fixture.owner)).toThrow('unavailable')
  expect(fixture.select).toHaveBeenCalledOnce()
})

it('clears tokens and timers on disposal and refuses reuse', () => {
  const fixture = setup()
  fixture.registry.dispose()
  fixture.registry.dispose()
  expect(fixture.capture.release).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  expect(() => fixture.registry.begin(identity, 'next', fixture.owner)).toThrow('unavailable')
})
