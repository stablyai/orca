import { describe, expect, it } from 'vitest'
import { normalizeOdooServerUrl, OdooServerUrlError } from './instance-credentials'

describe('normalizeOdooServerUrl', () => {
  it('defaults to https for a bare host and strips trailing path noise', () => {
    expect(normalizeOdooServerUrl(' odoo.local:8069/ ')).toBe('https://odoo.local:8069')
    expect(normalizeOdooServerUrl('https://acme.odoo.com/odoo/?db=x#frag')).toBe(
      'https://acme.odoo.com/odoo'
    )
  })

  it('keeps plain http only when the user types it', () => {
    // LAN and localhost Odoo are routinely plaintext, but that has to be a
    // deliberate choice — connect() sends the API key to whatever this returns.
    expect(normalizeOdooServerUrl('http://192.168.1.20:8069')).toBe('http://192.168.1.20:8069')
    expect(normalizeOdooServerUrl('http://localhost:8069/')).toBe('http://localhost:8069')
  })

  it('rejects transports that cannot carry an Odoo session', () => {
    expect(() => normalizeOdooServerUrl('ftp://odoo.local')).toThrow(OdooServerUrlError)
    expect(() => normalizeOdooServerUrl('file:///etc/passwd')).toThrow(OdooServerUrlError)
  })

  it('rejects a URL carrying userinfo, which would be persisted in cleartext', () => {
    // `url.toString()` keeps `user:password@`, and the instance file is not encrypted.
    expect(() => normalizeOdooServerUrl('https://user:secret@acme.odoo.com')).toThrow(
      OdooServerUrlError
    )
    expect(() => normalizeOdooServerUrl('https://user@acme.odoo.com')).toThrow(OdooServerUrlError)
    expect(() => normalizeOdooServerUrl('acme.odoo.com:8069')).not.toThrow()
  })
})
