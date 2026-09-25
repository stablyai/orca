import { describe, expect, it } from 'vitest'
import {
  assertShellMutation,
  assertUnrelatedDenial
} from '../experiments/android-automation/security-witnesses'

const mutation = { result: { type: 'string', value: 'shell-owned' } }
const denial = {
  uid: 10215,
  socket: 'webview_devtools_remote_4518',
  connected: false,
  rejected: 'java.io.IOException: Permission denied'
}

describe('Android automation security witnesses', () => {
  it('accepts the exact successful mutation', () => {
    expect(() => assertShellMutation(mutation)).not.toThrow()
  })
  it.each([
    { exceptionDetails: { text: 'review-forced-evaluation-failure' } },
    { ...mutation, exceptionDetails: { text: 'throw even with a value' } },
    { result: { type: 'string', value: 'wrong' } },
    { result: { type: 'undefined' } },
    { error: { message: 'protocol failure' } }
  ])('rejects failed or incorrect evaluation: %j', (result) => {
    expect(() => assertShellMutation(result)).toThrow()
  })
  it('accepts permission denial at the exact socket before connection', () => {
    expect(() => assertUnrelatedDenial(denial, denial.socket, 10214)).not.toThrow()
  })
  it.each([
    undefined,
    null,
    '10215',
    '10214',
    -1,
    1.5,
    Number.NaN,
    Infinity,
    -Infinity,
    {},
    [],
    true
  ])('rejects malformed UIDs on either side: %j', (uid) => {
    expect(() => assertUnrelatedDenial(denial, denial.socket, uid)).toThrow()
    expect(() => assertUnrelatedDenial({ ...denial, uid }, denial.socket, 10214)).toThrow()
  })
  it('rejects the same valid app UID', () => {
    expect(() => assertUnrelatedDenial(denial, denial.socket, denial.uid)).toThrow()
  })
  it('accepts zero as a valid distinct UID on either side', () => {
    expect(() => assertUnrelatedDenial(denial, denial.socket, 0)).not.toThrow()
    expect(() => assertUnrelatedDenial({ ...denial, uid: 0 }, denial.socket, 10214)).not.toThrow()
    expect(() => assertUnrelatedDenial({ ...denial, uid: 0 }, denial.socket, 0)).toThrow()
  })
  it.each([
    { socket: 'review-no-such-socket' },
    { socket: 'review-no-such-socket', rejected: 'java.io.IOException: Connection refused' },
    { rejected: 'java.io.IOException: Connection refused' },
    { rejected: 'java.net.SocketTimeoutException: timeout' },
    { rejected: 'java.lang.IllegalArgumentException: invalid address' },
    { connected: true },
    { connected: undefined },
    { rejected: undefined, bytes: -1 },
    { response: 'HTTP/1.1 200 OK' },
    { uid: 10214 },
    { uid: undefined }
  ])('rejects ambiguous or mismatched denial: %j', (change) => {
    expect(() => assertUnrelatedDenial({ ...denial, ...change }, denial.socket, 10214)).toThrow()
  })
})
