// What a provider send resolved to, before the send route maps it onto the
// contract's queued / dead / rate_limited / error statuses.
export type PushProviderOutcome =
  | { status: 'sent' }
  | { status: 'dead'; reason: string }
  | { status: 'error'; reason: string }
