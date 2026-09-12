import type { BunGlobal, BunRuntime } from './bun-pty-process-contract'

export function canUseBunPty(runtime = (globalThis as BunGlobal).Bun): boolean {
  return typeof runtime?.spawn === 'function' && runtime.Terminal !== undefined
}

export function resolveBunRuntime(runtime?: BunRuntime): BunRuntime {
  const resolved = runtime ?? (globalThis as BunGlobal).Bun
  if (!resolved) {
    throw new Error('Bun runtime is unavailable')
  }
  return resolved
}
