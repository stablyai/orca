import { describe, expect, it } from 'vitest'
import { HostProtocolAdmission } from './host-protocol-admission'

const compatible = {
  id: '1',
  ok: true as const,
  result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
}

describe('host protocol admission', () => {
  it('permits only the exact bootstrap method names before verification', () => {
    const admission = new HostProtocolAdmission()
    for (const method of [
      'status.get',
      'runtime.clientCapabilities.update',
      'pairing.provisionRelay',
      'pairing.getEndpoints'
    ]) {
      expect(admission.allows(method), method).toBe(true)
    }
    for (const method of ['worktree.ps', 'terminal.send', 'pairing.remove', 'runtime.other']) {
      expect(admission.allows(method), method).toBe(false)
    }
  })

  it('preserves a verified generation on failure and revokes it only for a mismatch or cutover', () => {
    const admission = new HostProtocolAdmission()
    admission.observe(compatible)
    admission.observe({ id: '2', ok: false, error: { code: 'unavailable', message: 'offline' } })
    admission.observe({ id: '3', ok: true, result: null })
    expect(admission.allows('terminal.send')).toBe(true)
    admission.observe({
      ...compatible,
      result: { protocolVersion: 3, minCompatibleMobileVersion: 4 }
    })
    expect(admission.allows('terminal.send')).toBe(false)
    admission.observe(compatible)
    expect(admission.allows('terminal.send')).toBe(true)
    admission.reset()
    expect(admission.allows('terminal.send')).toBe(false)
  })

  it('offers a wait only while a probe is deciding the verdict', async () => {
    const admission = new HostProtocolAdmission()
    expect(admission.whenProbed()).toBeNull()

    admission.beginProbe()
    const answered = admission.whenProbed()
    expect(answered).not.toBeNull()
    // A second probe cannot orphan the callers already parked on the first.
    admission.beginProbe()
    expect(admission.whenProbed()).toBe(answered)

    admission.endProbe()
    await expect(answered).resolves.toBeUndefined()
    expect(admission.whenProbed()).toBeNull()
  })

  it('releases the wait on reset so nobody parks on a retired generation', async () => {
    const admission = new HostProtocolAdmission()
    admission.beginProbe()
    const answered = admission.whenProbed()
    admission.reset()
    await expect(answered).resolves.toBeUndefined()
    expect(admission.whenProbed()).toBeNull()
  })
})
