import { describe, expect, it } from 'vitest'
import {
  ConnectorConnectErrorSchema,
  ConnectorConnectRedeemRequestSchema,
  ConnectorConnectRedeemSchema,
  ConnectorConnectStartRequestSchema
} from './connect-messages.js'

const CODE = 'a'.repeat(43)

describe('connect', () => {
  it('takes a loopback whole or not at all', () => {
    expect(ConnectorConnectStartRequestSchema.safeParse({ v: 1 }).success).toBe(true)
    expect(
      ConnectorConnectStartRequestSchema.safeParse({
        v: 1,
        loopbackPort: 53_682,
        loopbackNonce: CODE
      }).success
    ).toBe(true)
    expect(
      ConnectorConnectStartRequestSchema.safeParse({ v: 1, loopbackPort: 53_682 }).success
    ).toBe(false)
    expect(
      ConnectorConnectStartRequestSchema.safeParse({ v: 1, loopbackNonce: CODE }).success
    ).toBe(false)
  })

  it('refuses a privileged port, a short nonce and an odd result code', () => {
    expect(
      ConnectorConnectStartRequestSchema.safeParse({ v: 1, loopbackPort: 80, loopbackNonce: CODE })
        .success
    ).toBe(false)
    expect(
      ConnectorConnectStartRequestSchema.safeParse({
        v: 1,
        loopbackPort: 53_682,
        loopbackNonce: 'x'
      }).success
    ).toBe(false)
    expect(
      ConnectorConnectRedeemRequestSchema.safeParse({ v: 1, result: `${CODE}=` }).success
    ).toBe(false)
  })

  it('reads a redeemed identity with its install outcome, and the known errors only', () => {
    expect(
      ConnectorConnectRedeemSchema.parse({
        identity: { userId: 'u1', name: 'Dana Lee', handle: 'dana', email: 'dana@acme.dev' },
        workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
        install: 'needs_admin'
      }).install
    ).toBe('needs_admin')
    expect(ConnectorConnectErrorSchema.safeParse({ error: 'not_a_member' }).success).toBe(true)
    expect(ConnectorConnectErrorSchema.safeParse({ error: 'denied' }).success).toBe(false)
  })
})
