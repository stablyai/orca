import type { SendRequestOptions } from './rpc-client'
export class LogicalClientCutoverError extends Error {
  constructor() {
    super('RPC interrupted by connection migration')
  }
}

// Why: instanceof can miss across bundle copies, so also match by message.
export function isLogicalClientCutoverError(error: unknown): boolean {
  return (
    error instanceof LogicalClientCutoverError ||
    (error instanceof Error && error.message === 'RPC interrupted by connection migration')
  )
}

export function guardLogicalClientRequest(
  options: SendRequestOptions | undefined,
  isCurrent: () => boolean
): SendRequestOptions | undefined {
  if (!options?.beforeSend) {
    return options
  }
  return {
    ...options,
    beforeSend: () => {
      if (!isCurrent()) {
        throw new LogicalClientCutoverError()
      }
      options.beforeSend?.()
    }
  }
}
