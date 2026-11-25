import { expect, it } from 'vitest'
import { BrowserSessionCertificateDecisions } from './browser-session-certificate-decisions'

const identity = (port: number) => ({
  secureEndpoint: `https://localhost:${port}`,
  leafCertificateSha256: `sha-${port}`,
  error: 'net::ERR_CERT_AUTHORITY_INVALID'
})

it('accepts a new endpoint after 32 approvals by letting the oldest go', () => {
  const decisions = new BrowserSessionCertificateDecisions()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: decisions key on session identity only.
  const session = {} as Electron.Session
  for (let port = 3000; port < 3032; port++) {
    expect(decisions.accept(session, identity(port))).toBe(true)
  }
  expect(decisions.accept(session, identity(3032))).toBe(true)
  expect(decisions.trusts(session, identity(3032))).toBe(true)
  expect(decisions.trusts(session, identity(3000))).toBe(false)
  expect(decisions.trusts(session, identity(3001))).toBe(true)
})

it('trusts only the exact endpoint, certificate and error, in its own session, until the session ends', () => {
  const decisions = new BrowserSessionCertificateDecisions()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: decisions key on session identity only.
  const profile = {} as Electron.Session
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: another profile or route partition is another session.
  const otherPartition = {} as Electron.Session
  const approved = identity(3443)
  expect(decisions.accept(profile, approved)).toBe(true)
  expect(decisions.trusts(profile, approved)).toBe(true)
  expect(decisions.trusts(profile, { ...approved, error: 'net::ERR_CERT_DATE_INVALID' })).toBe(
    false
  )
  expect(decisions.trusts(profile, { ...approved, leafCertificateSha256: 'sha-other' })).toBe(false)
  expect(decisions.trusts(profile, { ...approved, secureEndpoint: 'https://localhost:3444' })).toBe(
    false
  )
  expect(decisions.trusts(profile, { ...approved, secureEndpoint: 'https://127.0.0.1:3443' })).toBe(
    false
  )
  expect(decisions.trusts(otherPartition, approved)).toBe(false)
  decisions.forget(profile)
  expect(decisions.trusts(profile, approved)).toBe(false)
})
