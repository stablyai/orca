import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectiveEgressPreset, egressPolicy, type LifecycleDeps } from '../src/lifecycle'
import type { SandboxRow } from '../src/store'

const row = { id: 'sbx_guard', egress_secret_hosts: null, egress_allow_hosts: null, egress_user_hosts: null } as unknown as SandboxRow
const PROXY = 'https://cp.example.dev/v1/egress/proxy'
const deps = (environment: string, egressProxyUrl?: string) =>
  ({ config: { environment, goldenSnapshotId: 'snap', defaultRegion: 'iad1', ...(egressProxyUrl ? { egressProxyUrl } : {}) } }) as unknown as LifecycleDeps

describe('E3-PROD-GUARD: open egress never runs without the egress proxy in a deployed env', () => {
  afterEach(() => vi.restoreAllMocks())

  it('dev or prod without EGRESS_PROXY_URL falls back to limited and logs it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const environment of ['dev', 'prod', 'staging']) {
      const d = deps(environment)
      expect(effectiveEgressPreset(d, row)).toBe('limited')
      expect(egressPolicy(d, row, 'ghs_REALTOKEN').allow['*']).toBeUndefined()
    }
    const events = errors.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; applied: string })
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every((e) => e.event === 'egress_open_without_proxy' && e.applied === 'limited')).toBe(true)
  })

  it('with the proxy URL a deployed env stays open and the git token is forwarded, never in the policy', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const d = deps('prod', PROXY)
    expect(effectiveEgressPreset(d, row)).toBe('open')
    const policy = egressPolicy(d, row, 'ghs_REALTOKEN')
    expect(policy.allow['*']).toEqual([])
    expect(policy.allow['github.com']![0]).toMatchObject({ forwardURL: PROXY })
    expect(JSON.stringify(policy)).not.toContain('ghs_REALTOKEN')
    expect(errors).not.toHaveBeenCalled()
  })

  it('local and test keep open without a proxy (dev loops and the unit harness)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(effectiveEgressPreset(deps('local'), row)).toBe('open')
    expect(effectiveEgressPreset(deps('test'), row)).toBe('open')
    expect(errors).not.toHaveBeenCalled()
  })
})
