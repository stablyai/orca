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
