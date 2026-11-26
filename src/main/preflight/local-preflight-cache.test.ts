import { expect, it } from 'vitest'
import { shouldRefreshLocalPreflight, type PreflightStatus } from './agent-detection'

const NOW = 1_000_000

function status(overrides: Partial<PreflightStatus> = {}): PreflightStatus {
  return {
    git: { installed: true },
    gh: { installed: true, authenticated: true },
    ...overrides
  }
}

function entry(result: PreflightStatus, expired: boolean) {
  return { result, expiresAt: expired ? NOW - 1 : NOW + 1 }
}

it('probes when there is no local result', () => {
  expect(shouldRefreshLocalPreflight(null, NOW)).toBe(true)
})

it('keeps a not-ready local result inside its TTL (#49583)', () => {
  expect(
    shouldRefreshLocalPreflight(
      entry(status({ gh: { installed: true, authenticated: false } }), false),
      NOW
    )
  ).toBe(false)
})

it('reprobes an expired not-ready local result (#49583)', () => {
  expect(
    shouldRefreshLocalPreflight(
      entry(status({ gh: { installed: true, authenticated: false } }), true),
      NOW
    )
  ).toBe(true)
})

it('keeps a fully ready local result even after the TTL', () => {
  expect(shouldRefreshLocalPreflight(entry(status(), true), NOW)).toBe(false)
})

it('expires an unauthenticated glab verdict even when gh is ready', () => {
  const result = status({ glab: { installed: true, authenticated: false } })
  expect(shouldRefreshLocalPreflight(entry(result, true), NOW)).toBe(true)
  expect(
    shouldRefreshLocalPreflight(
      entry(status({ glab: { installed: true, authenticated: true } }), true),
      NOW
    )
  ).toBe(false)
})

it('expires a result when git is missing or an auxiliary forge is configured but signed out', () => {
  expect(shouldRefreshLocalPreflight(entry(status({ git: { installed: false } }), true), NOW)).toBe(
    true
  )
  expect(
    shouldRefreshLocalPreflight(
      entry(
        status({
          gitea: {
            configured: true,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          }
        }),
        true
      ),
      NOW
    )
  ).toBe(true)
})
