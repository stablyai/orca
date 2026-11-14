import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

export type ClaudePermissionCancellation = {
  wasWithdrawn: (requestId: string) => boolean
}

/** SDK cleanup also aborts permission signals; only an exact wire cancel is a withdrawal. */
export function claudePermissionCancellation() {
  const requests = new Map<string, boolean>()
  const callbacks = new Map<string, number>()
  const remember = (frame: unknown): void => {
    if (typeof frame !== 'object' || frame === null || !('type' in frame)) {
      return
    }
    if (
      frame.type === 'control_response' &&
      'response' in frame &&
      typeof frame.response === 'object' &&
      frame.response !== null &&
      'pending_permission_requests' in frame.response &&
      Array.isArray(frame.response.pending_permission_requests)
    ) {
      for (const request of frame.response.pending_permission_requests) {
        remember(request)
      }
    }
    if (!('request_id' in frame) || typeof frame.request_id !== 'string') {
      return
    }
    if (
      frame.type === 'control_request' &&
      'request' in frame &&
      typeof frame.request === 'object' &&
      frame.request !== null &&
      'subtype' in frame.request &&
      frame.request.subtype === 'can_use_tool'
    ) {
      if (!requests.has(frame.request_id)) {
        requests.set(frame.request_id, false)
      }
    } else if (frame.type === 'control_cancel_request' && requests.has(frame.request_id)) {
      requests.set(frame.request_id, true)
    }
  }
  return {
    wrap:
      (callback: CanUseTool): CanUseTool =>
      async (...args) => {
        const id = args[2].requestId
        callbacks.set(id, (callbacks.get(id) ?? 0) + 1)
        try {
          return await callback(...args)
        } finally {
          const remaining = (callbacks.get(id) ?? 1) - 1
          if (remaining > 0) {
            callbacks.set(id, remaining)
          } else {
            callbacks.delete(id)
            requests.delete(id)
          }
        }
      },
    observeLine: (line: string): void => {
      try {
        remember(JSON.parse(line))
      } catch {
        // The SDK also skips malformed records.
      }
    },
    wasWithdrawn: (requestId: string): boolean => requests.get(requestId) === true,
    release: (requestId: string): void => {
      requests.delete(requestId)
    },
    close: (): void => {
      for (const id of requests.keys()) {
        if (!callbacks.has(id)) {
          requests.delete(id)
        }
      }
    }
  }
}
