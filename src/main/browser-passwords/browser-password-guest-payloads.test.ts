import { describe, expect, it } from 'vitest'
import {
  readBrowserPasswordCapture,
  readBrowserPasswordFieldFocused,
  readBrowserPasswordFormSummaries,
  readBrowserPasswordSubmitted
} from './browser-password-guest-payloads'

const summary = {
  formSignature: 'form-1',
  kind: 'login',
  usernameFieldName: 'email',
  passwordFieldName: 'password',
  action: null
}

describe('browser password guest payloads', () => {
  it('reads a well-formed capture and normalises empty values to null', () => {
    expect(
      readBrowserPasswordCapture({ ...summary, username: '', password: 'pw', newPassword: null })
    ).toEqual({ ...summary, username: null, password: 'pw', newPassword: null })
  })

  it('refuses unknown form kinds, non-string values and oversized secrets', () => {
    expect(readBrowserPasswordCapture({ ...summary, kind: 'admin', password: 'pw' })).toBeNull()
    expect(readBrowserPasswordCapture({ ...summary, password: 42 })).toBeNull()
    expect(readBrowserPasswordCapture({ ...summary, password: 'x'.repeat(1001) })).toBeNull()
    expect(readBrowserPasswordCapture(null)).toBeNull()
  })

  it('requires a known submit source', () => {
    const capture = { ...summary, username: 'ada', password: 'pw', newPassword: null }
    expect(readBrowserPasswordSubmitted({ ...capture, source: 'enter' })?.source).toBe('enter')
    expect(readBrowserPasswordSubmitted({ ...capture, source: 'script' })).toBeNull()
  })

  it('refuses a form list with any malformed form', () => {
    expect(readBrowserPasswordFormSummaries({ forms: [summary] })).toEqual([summary])
    expect(readBrowserPasswordFormSummaries({ forms: [summary, { formSignature: 1 }] })).toBeNull()
  })

  it('reads a focused field and rejects non-finite geometry', () => {
    const focused = {
      fieldToken: 't',
      formSignature: 'form-1',
      role: 'password',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      viewportWidth: 800
    }
    expect(readBrowserPasswordFieldFocused(focused)).toEqual(focused)
    expect(
      readBrowserPasswordFieldFocused({ ...focused, rect: { ...focused.rect, x: Infinity } })
    ).toBeNull()
  })
})
