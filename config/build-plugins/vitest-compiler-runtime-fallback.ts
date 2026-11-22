import { createRequire } from 'node:module'

// Why: hook-harness tests mock React or call hooks outside render; there, run uncached like uncompiled code.
const require = createRequire(import.meta.url)
const react: {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown }
} = require('react')
const internals = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
const runtime: { c: (size: number) => unknown[] } = require('react/compiler-runtime')
const sentinel = Symbol.for('react.memo_cache_sentinel')
const uncached = (size: number): unknown[] => Array.from({ length: size }, () => sentinel)

export function c(size: number): unknown[] {
  if (!internals.H) {
    return uncached(size)
  }
  try {
    return runtime.c(size)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid hook call')) {
      return uncached(size)
    }
    throw error
  }
}
