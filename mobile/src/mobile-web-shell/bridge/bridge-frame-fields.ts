import { z } from 'zod'
import { BRIDGE_MAX_METHOD_CHARS } from './bridge-caps'

// Version gates incompatible shape; negotiate capabilities through grants. Drop unknown keys so independently updated desktop bundles and installed shells tolerate additive fields.
// New closed-list values are incompatible: older readers reject the whole frame. Negotiate them like opcodes rather than assuming unknown-key tolerance applies.
export const BRIDGE_PROTOCOL_VERSION = 1

export const BRIDGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export const versionSchema = z.literal(BRIDGE_PROTOCOL_VERSION)
export const idSchema = z.string().regex(BRIDGE_ID_PATTERN)
// Constrain length only; method existence belongs to the desktop allowlist, whose valid names must not be rejected by a guessed charset.
export const methodSchema = z.string().min(1).max(BRIDGE_MAX_METHOD_CHARS)

export const BRIDGE_FOREGROUND_NUDGE_REASONS = ['focus', 'app-resume', 'network-change'] as const

// Negotiate fault before posting it; older shells reject unknown notify names as whole frames.
export const BRIDGE_FAULT_GRANT = 'fault'

// The page owns one replaced history entry, so Back must pop native history. Reuse navigate rather than adding a grant absent from released routes.
export const BRIDGE_NAVIGATE_BACK_NOTIFY = 'navigate-back'

// External-link opening is separate from in-app navigation; shells may implement one without the other, so policy needs distinct grants.
export const BRIDGE_EXTERNAL_LINK_GRANT = 'externalLink'

// Negotiate rpcEnvelope before relying on extra wire fields; older shells drop unknown fields and could execute without caller-required metadata.
export const BRIDGE_RPC_ENVELOPE_GRANT = 'rpcEnvelope'
