import assert from 'node:assert/strict'

function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
}

export function assertShellMutation(value: unknown): void {
  record(value)
  assert.equal(value.exceptionDetails, undefined, 'Shell evaluation threw')
  record(value.result)
  assert.equal(value.result.type, 'string')
  assert.equal(value.result.value, 'shell-owned', 'Shell mutation witness missing')
}

function uid(value: unknown): asserts value is number {
  assert(typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

export function assertUnrelatedDenial(value: unknown, socket: string, appUid: unknown): void {
  record(value)
  assert.equal(value.socket, socket, 'Unrelated UID probed a different socket')
  uid(value.uid)
  uid(appUid)
  assert.notEqual(value.uid, appUid)
  assert.equal(value.connected, false, 'Expected denial at socket connect')
  assert.equal(value.response, undefined, 'Unrelated UID received discovery data')
  assert.equal(value.bytes, undefined, 'Probe reached socket read')
  // This witnesses Android connect denial, not Chromium peer-credential authentication.
  assert.equal(value.rejected, 'java.io.IOException: Permission denied')
}
