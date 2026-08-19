import type { LinearClient } from '@linear/sdk'
import { createRequire } from 'node:module'
import { getLinearApiDispatcher } from './linear-api-dispatcher'

// The subset of @linear/sdk that client.ts constructs / type-checks. Declared
// structurally (not `typeof import('@linear/sdk')`) so this loader never forces
// an eager module import and satisfies the no-`import()`-type lint rule.
export type LinearSdkModule = {
  // Why: LinearClientOptions extends RequestInit and the SDK spreads the extra
  // keys straight into its fetch call, which is how `dispatcher` reaches undici.
  LinearClient: new (options: LinearClientOptions & { dispatcher?: unknown }) => LinearClient
  AuthenticationLinearError: new (...args: never[]) => Error
}

export type LinearClientOptions = {
  apiKey: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

// Why: @linear/sdk is a ~2.6MB CJS bundle (~33ms to parse). The Linear client
// module is imported on the main-process startup path (orca-runtime + ipc), but
// the SDK itself is only needed once the user actually acts on Linear. Load it
// lazily via createRequire so launch never parses it for the majority who never
// connect Linear, and cache it so repeat calls are free. The accessor stays
// synchronous so the client factories don't have to become async.
//
// Kept in its own module (rather than a bare createRequire in client.ts) so
// tests can mock the loader — a raw createRequire bypasses vitest's module
// registry, but `vi.doMock('./linear-sdk', …)` on this module works.
const requireFromMain = createRequire(__filename)
let cached: LinearSdkModule | null = null

export function loadLinearSdk(): LinearSdkModule {
  cached ??= requireFromMain('@linear/sdk') as LinearSdkModule
  return cached
}

// Why: the single place Linear clients are built, so every Linear request picks
// up OS certificate trust. Constructing LinearClient directly re-opens
// orca#12189 on TLS-inspecting networks.
export function createLinearClient(options: LinearClientOptions): LinearClient {
  const dispatcher = getLinearApiDispatcher()
  return new (loadLinearSdk().LinearClient)({
    ...options,
    ...(dispatcher ? { dispatcher } : {})
  })
}
