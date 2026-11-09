import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { extraEgressHostsFor } from '../src/index'

const env = (vars: Partial<Env>) => vars as Env

describe('extraEgressHostsFor', () => {
  it('lets VMs reach the control plane the in-VM CLI is told to call', () => {
    expect(extraEgressHostsFor(env({ PUBLIC_API_URL: 'https://cp.example.dev/' }))).toEqual(['cp.example.dev'])
  })

  it('keeps EGRESS_EXTRA_HOSTS and de-duplicates', () => {
    expect(
      extraEgressHostsFor(env({ EGRESS_EXTRA_HOSTS: 'a.dev, cp.example.dev', PUBLIC_API_URL: 'https://cp.example.dev' }))
    ).toEqual(['a.dev', 'cp.example.dev'])
  })

  it('falls back to the egress proxy origin, and to nothing', () => {
    expect(extraEgressHostsFor(env({ EGRESS_PROXY_URL: 'https://proxy.example.dev/egress' }))).toEqual(['proxy.example.dev'])
    expect(extraEgressHostsFor(env({}))).toEqual([])
  })
})
