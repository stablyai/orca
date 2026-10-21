import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { isRemoteCliControlAllowed } from '../../../shared/ssh-remote-cli-control'
import { normalizeSshTarget } from './ssh-normalization'

const base: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

describe("loading a host's orca CLI control switch", () => {
  it('keeps a saved true on load, with or without the retired consent stamp', () => {
    const plain = normalizeSshTarget({ ...base, allowRemoteCliControl: true })
    const stamped = normalizeSshTarget({
      ...base,
      allowRemoteCliControl: true,
      allowRemoteCliControlConsent: 'desktop-browser-bridge'
    })

    expect(plain.allowRemoteCliControl).toBe(true)
    expect(isRemoteCliControlAllowed(plain)).toBe(true)
    expect(stamped.allowRemoteCliControl).toBe(true)
  })

  it('keeps an explicit false off and an absent value on', () => {
    const off = normalizeSshTarget({ ...base, allowRemoteCliControl: false })
    const absent = normalizeSshTarget(base)

    expect(off.allowRemoteCliControl).toBe(false)
    expect(isRemoteCliControlAllowed(off)).toBe(false)
    expect(absent.allowRemoteCliControl).toBeUndefined()
    expect(isRemoteCliControlAllowed(absent)).toBe(true)
  })

  it('drops the retired reset notice, so a host an earlier build reset is on again', () => {
    const resetByEarlierBuild = { ...base, allowRemoteCliControlReset: true }
    const loaded = normalizeSshTarget(resetByEarlierBuild)

    expect(loaded).not.toHaveProperty('allowRemoteCliControlReset')
    expect(isRemoteCliControlAllowed(loaded)).toBe(true)
  })

  it('never allows a missing target', () => {
    expect(isRemoteCliControlAllowed(undefined)).toBe(false)
    expect(isRemoteCliControlAllowed(null)).toBe(false)
  })
})
