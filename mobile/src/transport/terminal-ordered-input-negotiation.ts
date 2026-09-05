import { TERMINAL_ORDERED_INPUT_CAPABILITY } from '../../../src/shared/terminal-ordered-input'

export type Limits = {
  version: 1
  maxFrameBytes: number
  maxPendingBytes: number
  maxPendingFrames: number
}
export function advertiseTerminalOrderedInput(method: string, params: unknown): unknown {
  if (method !== 'terminal.subscribe' || !params || typeof params !== 'object') {
    return params
  }
  const existing = (params as { capabilities?: unknown }).capabilities
  return {
    ...params,
    capabilities: { ...(existing && typeof existing === 'object' ? existing : {}), orderedInput: 1 }
  }
}

export function parseLimits(value: unknown): Limits | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const limits = value as Limits
  if (limits.version !== 1) {
    return null
  }
  for (const key of ['maxFrameBytes', 'maxPendingBytes', 'maxPendingFrames'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      return null
    }
  }
  return {
    version: 1,
    maxFrameBytes: Math.min(limits.maxFrameBytes, TERMINAL_ORDERED_INPUT_CAPABILITY.maxFrameBytes),
    maxPendingBytes: Math.min(
      limits.maxPendingBytes,
      TERMINAL_ORDERED_INPUT_CAPABILITY.maxPendingBytes
    ),
    maxPendingFrames: Math.min(
      limits.maxPendingFrames,
      TERMINAL_ORDERED_INPUT_CAPABILITY.maxPendingFrames
    )
  }
}
