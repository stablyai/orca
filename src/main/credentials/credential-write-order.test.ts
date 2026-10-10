import { describe, expect, it } from 'vitest'
import { CredentialSaveSupersededError, CredentialWriteOrder } from './credential-write-order'

describe('CredentialWriteOrder', () => {
  it('lets the latest save of a credential write', () => {
    const order = new CredentialWriteOrder('Test key')
    const turn = order.begin()
    expect(() => turn.assertLatest()).not.toThrow()
  })

  it('rejects a save once a later save or clear of the same credential started', () => {
    const order = new CredentialWriteOrder('Test key')
    const first = order.begin('a')
    const second = order.begin('a')
    order.begin('a')

    expect(() => first.assertLatest()).toThrow(CredentialSaveSupersededError)
    expect(() => second.assertLatest()).toThrow('Test key changed while it was being saved')
  })

  it('keeps credentials under different keys independent', () => {
    const order = new CredentialWriteOrder('Test key')
    const a = order.begin('a')
    order.begin('b')
    expect(() => a.assertLatest()).not.toThrow()
  })

  it('rejects every earlier save after a clear of all credentials, but not later ones', () => {
    const order = new CredentialWriteOrder('Test key')
    const before = order.begin('a')
    order.beginClearAll()
    const after = order.begin('b')

    expect(() => before.assertLatest()).toThrow(CredentialSaveSupersededError)
    expect(() => after.assertLatest()).not.toThrow()
  })
})
