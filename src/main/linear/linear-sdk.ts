import type { LinearClient } from '@linear/sdk'
import { createRequire } from 'node:module'

// Keep a structural loader type without import-type expressions or eager SDK initialization.
export type LinearSdkModule = {
  LinearClient: new (options: {
    apiKey: string
    headers?: Record<string, string>
    signal?: AbortSignal
  }) => LinearClient
  AuthenticationLinearError: new (...args: never[]) => Error
}

// Lazy synchronous loading keeps SDK parsing off startup; a separate module lets tests mock createRequire access.
const requireFromMain = createRequire(__filename)
let cached: LinearSdkModule | null = null

export function loadLinearSdk(): LinearSdkModule {
  cached ??= requireFromMain('@linear/sdk') as LinearSdkModule
  return cached
}
