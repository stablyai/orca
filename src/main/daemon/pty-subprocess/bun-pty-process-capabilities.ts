import type { BunRuntime } from './bun-pty-process-contract'

function currentRuntime(): unknown {
  return 'Bun' in globalThis ? globalThis.Bun : undefined
}

function isBunRuntime(runtime: unknown): runtime is BunRuntime {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    'spawn' in runtime &&
    typeof runtime.spawn === 'function' &&
    'Terminal' in runtime &&
    typeof runtime.Terminal === 'function'
  )
}

export function canUseBunPty(runtime: unknown = currentRuntime()): boolean {
  return isBunRuntime(runtime)
}

export function resolveBunRuntime(runtime: unknown = currentRuntime()): BunRuntime {
  if (!isBunRuntime(runtime)) {
    throw new Error('Bun terminal runtime is unavailable')
  }
  return runtime
}
