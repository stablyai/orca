import type {
  BrowserConsoleEntry,
  BrowserConsoleResult,
  BrowserNetworkEntry,
  BrowserNetworkLogResult
} from '../../shared/runtime-types'

// Shapes agent-browser prints for `console --json` and `network requests --json` (0.27 and 0.41).
export type AgentBrowserConsoleOutput = { messages: { type: string; text: string }[] }
export type AgentBrowserNetworkOutput = {
  requests: {
    url: string
    method: string
    status?: number
    mimeType?: string
    timestamp?: number
  }[]
}

function keepLast<T, U>(
  items: T[],
  limit: number | undefined,
  toEntry: (item: T) => U
): { entries: U[]; truncated: boolean } {
  const truncated = limit !== undefined && items.length > limit
  return { entries: (truncated ? items.slice(-limit) : items).map(toEntry), truncated }
}

export function toBrowserConsoleResult(
  output: AgentBrowserConsoleOutput,
  limit: number | undefined
): BrowserConsoleResult {
  return keepLast(output.messages, limit, (m): BrowserConsoleEntry => ({
    level: m.type,
    text: m.text
  }))
}

export function toBrowserNetworkLogResult(
  output: AgentBrowserNetworkOutput,
  limit: number | undefined
): BrowserNetworkLogResult {
  return keepLast(output.requests, limit, (r): BrowserNetworkEntry => ({
    url: r.url,
    method: r.method,
    status: r.status,
    mimeType: r.mimeType,
    timestamp: r.timestamp
  }))
}
