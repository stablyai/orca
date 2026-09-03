import { describe, expect, it } from 'vitest'
import type { RpcRequest } from './core'
import { needsLocalCallerFingerprint } from './dispatcher-caller-fingerprint'

function request(method: string): RpcRequest {
  return { id: 'request-1', authToken: 'token', method }
}

describe('needsLocalCallerFingerprint', () => {
  it.each(['terminal.identityProof.begin', 'terminal.identityProof.complete'])(
    'binds %s to the authenticated local caller',
    (method) => {
      expect(needsLocalCallerFingerprint(request(method), {})).toBe(true)
    }
  )

  it('does not broaden caller fingerprinting to ordinary terminal methods', () => {
    expect(needsLocalCallerFingerprint(request('terminal.list'), {})).toBe(false)
  })
})
