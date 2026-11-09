// `orca://cloud-share/<token>` from a team-only share page: links can arrive before Orca Cloud is
// wired (cold start), so they wait here until the handler is registered.
import { parseCloudShareDeepLink } from '../../shared/hosted-sandbox/hosted-sandbox-share-wire'

type Handler = (token: string) => void
let handler: Handler | null = null
/** Builds without Orca Cloud never handle these; the link then activates Orca like any other. */
let disabled = false
const pending: string[] = []

export function disableCloudShareDeepLinks(): void {
  disabled = true
  pending.length = 0
}

export function setCloudShareDeepLinkHandler(next: Handler): void {
  handler = next
  for (const token of pending.splice(0)) {
    next(token)
  }
}

/** Takes the share links among launch/second-instance arguments; returns whether any matched. */
export function captureCloudShareDeepLinks(argv: readonly string[]): boolean {
  if (disabled) {
    return false
  }
  let matched = false
  for (const arg of argv) {
    const token = parseCloudShareDeepLink(arg)
    if (!token) {
      continue
    }
    matched = true
    if (handler) {
      handler(token)
    } else if (pending.length < 8) {
      pending.push(token)
    }
  }
  return matched
}
