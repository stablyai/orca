import { z } from 'zod'

// Connecting Linear or GitHub in one browser trip: the owner signs in (and installs Orca there if it
// is missing), and the browser hands the result back to the Orca that started it.

// 32 random bytes, base64url: the loopback's nonce, and the one-time result code.
export const CONNECTOR_CONNECT_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const Code = z.string().regex(CONNECTOR_CONNECT_CODE_PATTERN)
// An X25519 public key, raw and base64url (connect-login-seal.ts).
export const CONNECT_LOGIN_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

// Where the cloud's last redirect lands on the starting machine:
// http://127.0.0.1:<loopbackPort>/connector/done?r=<result>&n=<loopbackNonce>. Without a loopback,
// the browser ends on a page whose "Open Orca" opens orca://<linear|github>/link?t=<result>.
export const CONNECTOR_CONNECT_LOOPBACK_PATH = '/connector/done'

// POST `${linear|github}/connect`: starts a trip for the signed-in account; a new start voids the
// account's earlier one. The loopback is given whole or not at all. switchAccount asks the service to
// offer its account picker again ("Not you?"). loginKey (Linear): the Mac also wants the person's
// read,write login, sealed to this X25519 key (connect-login-seal.ts); without it the trip only
// identifies them. addAccess (GitHub): the trip adds access, so after the sign-in it goes on to
// GitHub's install page unless the login reaches `workspace` (an org or user login); with none named
// it always does. A cloud older than it ignores it.
export const ConnectorConnectStartRequestSchema = z
  .object({
    v: z.literal(1),
    loopbackPort: z.number().int().min(1024).max(65_535).optional(),
    loopbackNonce: Code.optional(),
    switchAccount: z.literal(true).optional(),
    loginKey: z.string().regex(CONNECT_LOGIN_KEY_PATTERN).optional(),
    // A GitHub login; the cloud checks its shape (GITHUB_LOGIN_PATTERN).
    addAccess: z.object({ workspace: z.string().min(1).max(39).optional() }).optional()
  })
  .refine((start) => (start.loopbackPort === undefined) === (start.loopbackNonce === undefined), {
    message: 'loopbackPort and loopbackNonce go together'
  })
export const ConnectorConnectStartSchema = z.object({ authorizeUrl: z.string().url() })

// What the trip did about installing Orca where the person works: installed (now or already),
// needs_admin (Linear: they can't install it; a workspace admin can), requested (GitHub: an
// organization owner has to approve), none (not installed: the install was cancelled or failed).
export const CONNECTOR_CONNECT_INSTALL_OUTCOMES = [
  'installed',
  'needs_admin',
  'requested',
  'none'
] as const

// POST `${linear|github}/connect/redeem` {v:1, result}: links the account to whom the trip proved,
// spending the code. Only the account that started the trip may redeem it.
export const ConnectorConnectRedeemRequestSchema = z.object({ v: z.literal(1), result: Code })

export const ConnectorConnectRedeemSchema = z.object({
  // The service's own record of the person: its id, display name, handle (GitHub login, Linear
  // display name) and, where it has one, email. Shown as "Signed in as …" with "Not you?".
  identity: z.object({
    userId: z.string().min(1),
    name: z.string(),
    handle: z.string(),
    email: z.string().optional()
  }),
  // Linear: the workspace the person signed in to; its label always includes linear.app/<urlKey>.
  workspace: z.object({ id: z.string().min(1), name: z.string(), urlKey: z.string() }).optional(),
  install: z.enum(CONNECTOR_CONNECT_INSTALL_OUTCOMES),
  // Linear, for a start that sent loginKey: the person's login sealed to it.
  sealedLogin: z.string().min(1).optional()
})

// The 409s: expired (unknown, used or past its 10 minutes, or voided by a later start),
// wrong_account (another account started the trip), not_a_member (a Linear guest, inactive user or
// app). An account links several people and a person several accounts, so already_linked is no
// longer sent; it stays listed for the Orcas that still read it.
export const CONNECTOR_CONNECT_ERRORS = [
  'expired',
  'wrong_account',
  'already_linked',
  'not_a_member'
] as const
export const ConnectorConnectErrorSchema = z.object({ error: z.enum(CONNECTOR_CONNECT_ERRORS) })

export type ConnectorConnectStartRequest = z.infer<typeof ConnectorConnectStartRequestSchema>
export type ConnectorConnectStart = z.infer<typeof ConnectorConnectStartSchema>
export type ConnectorConnectRedeemRequest = z.infer<typeof ConnectorConnectRedeemRequestSchema>
export type ConnectorConnectRedeem = z.infer<typeof ConnectorConnectRedeemSchema>
export type ConnectorConnectInstallOutcome = (typeof CONNECTOR_CONNECT_INSTALL_OUTCOMES)[number]
export type ConnectorConnectError = (typeof CONNECTOR_CONNECT_ERRORS)[number]
