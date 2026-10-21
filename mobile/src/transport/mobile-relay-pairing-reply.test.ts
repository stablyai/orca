import { describe, expect, it } from 'vitest'
import { RpcIncompatibleReplyError } from './rpc-incompatible-reply-error'
import {
  relayCredentialProvision,
  relayPairingEndpointsRead
} from './mobile-relay-pairing-operations'
import type { RpcResponse } from './types'

// The two pairing readers are the shared credential contract, moved off four call sites that each
// ran `.parse()` on the interpreted value. These pin that the move kept the contract exactly and
// changed only where the refusal is raised.

function success(result: unknown): RpcResponse {
  return { ok: true, result }
}

const installed = {
  v: 1,
  reqId: 'req-1',
  authorizationMode: 'relay-basis',
  currentVersion: 2,
  resumeExpiresAt: 1700000000000
}

const endpoints = {
  v: 1,
  relay: null,
  installStatus: { v: 1, reqId: 'req-1', state: 'committed', result: installed }
}

describe('the provision reader is the install contract', () => {
  it('reads a committed install', () => {
    expect(relayCredentialProvision.interpret(success(installed))).toEqual(installed)
  })

  it('refuses an install the contract refuses, naming the method', () => {
    expect(() => relayCredentialProvision.interpret(success({ ...installed, v: 2 }))).toThrow(
      RpcIncompatibleReplyError
    )
    // `.strict()` is main's shipped rule for this released pairing surface, not a new one.
    expect(() => relayCredentialProvision.interpret(success({ ...installed, extra: 1 }))).toThrow(
      RpcIncompatibleReplyError
    )
    expect(() => relayCredentialProvision.interpret(success(null))).toThrow(
      /could not read \(pairing\.provisionRelay\)/
    )
  })
})

describe('the endpoints reader is the endpoints contract', () => {
  it('reads the authoritative view every caller commits on', () => {
    expect(relayPairingEndpointsRead.interpret(success(endpoints))).toEqual(endpoints)
  })

  it('refuses an endpoints reply missing the nullable relay member', () => {
    expect(() => relayPairingEndpointsRead.interpret(success({ v: 1 }))).toThrow(
      RpcIncompatibleReplyError
    )
    expect(() => relayPairingEndpointsRead.interpret(success(undefined))).toThrow(
      /could not read \(pairing\.getEndpoints\)/
    )
  })

  it('still raises the host code and message on a refusal, ahead of the reader', () => {
    const refusal: RpcResponse = { ok: false, error: { code: 'forbidden', message: 'no' } }
    expect(() => relayPairingEndpointsRead.interpret(refusal)).toThrow('forbidden: no')
  })
})
