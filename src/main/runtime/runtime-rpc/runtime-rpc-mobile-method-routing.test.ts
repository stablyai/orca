import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc-mobile-method-allowlist'
import {
  EXECUTION_HOST_METHODS,
  MOBILE_RPC_METHOD_ROUTES
} from './runtime-rpc-mobile-method-routing'
import { PAIRED_DESKTOP_METHODS } from './runtime-rpc-mobile-paired-desktop-methods'

describe('mobile RPC method routing census', () => {
  it('tags every allowlisted method exactly once', () => {
    const untagged = [...MOBILE_RPC_METHOD_ALLOWLIST].filter(
      (method) => !MOBILE_RPC_METHOD_ROUTES.has(method)
    )
    expect(untagged).toEqual([])
    expect(PAIRED_DESKTOP_METHODS.length + EXECUTION_HOST_METHODS.length).toBe(
      MOBILE_RPC_METHOD_ROUTES.size
    )
  })

  it('sends a targeted status to the server, whose features a server workspace gates on', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('status.get')).toBe('execution-host')
  })

  it('tags nothing outside the allowlist', () => {
    const stale = [...MOBILE_RPC_METHOD_ROUTES.keys()].filter(
      (method) => !MOBILE_RPC_METHOD_ALLOWLIST.has(method)
    )
    expect(stale).toEqual([])
  })
})
