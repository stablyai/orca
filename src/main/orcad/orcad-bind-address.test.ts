import { describe, expect, it } from 'vitest'
import {
  bindHostIsNetworkExposed,
  describeOrcadBindExposure,
  ORCAD_LOOPBACK_BIND_HOST,
  OrcadBindAddressError,
  resolveOrcadBindHost
} from './orcad-bind-address'

describe('resolveOrcadBindHost', () => {
  it('defaults to loopback when the operator asked for nothing', () => {
    expect(resolveOrcadBindHost()).toBe(ORCAD_LOOPBACK_BIND_HOST)
    expect(ORCAD_LOOPBACK_BIND_HOST).toBe('127.0.0.1')
  })

  it('accepts literal IPv4 and IPv6 addresses, including explicit wide binds', () => {
    expect(resolveOrcadBindHost('0.0.0.0')).toBe('0.0.0.0')
    expect(resolveOrcadBindHost('10.1.2.3')).toBe('10.1.2.3')
    expect(resolveOrcadBindHost('::1')).toBe('::1')
    expect(resolveOrcadBindHost('localhost')).toBe('127.0.0.1')
    expect(resolveOrcadBindHost(' 127.0.0.1 ')).toBe('127.0.0.1')
  })

  it('refuses hostnames, because DNS would decide which interface got bound', () => {
    expect(() => resolveOrcadBindHost('internal.example')).toThrow(OrcadBindAddressError)
    expect(() => resolveOrcadBindHost('')).toThrow(OrcadBindAddressError)
    expect(() => resolveOrcadBindHost('0.0.0.0:80')).toThrow(OrcadBindAddressError)
  })
})

describe('bindHostIsNetworkExposed', () => {
  it('separates local-only addresses from network-reachable ones', () => {
    expect(bindHostIsNetworkExposed('127.0.0.1')).toBe(false)
    expect(bindHostIsNetworkExposed('127.5.5.5')).toBe(false)
    expect(bindHostIsNetworkExposed('::1')).toBe(false)
    expect(bindHostIsNetworkExposed('0.0.0.0')).toBe(true)
    expect(bindHostIsNetworkExposed('::')).toBe(true)
    expect(bindHostIsNetworkExposed('10.1.2.3')).toBe(true)
  })

  it('says out loud when a deployment is reachable from the network', () => {
    expect(describeOrcadBindExposure('0.0.0.0')).toContain('reachable from the network')
    expect(describeOrcadBindExposure('127.0.0.1')).toContain('local only')
  })
})
