import { get } from 'node:https'
import { isValidAppVersion } from '../../shared/app-version'

// Claude's native updater publishes read-only stable/latest version pointers here.
const CLAUDE_RELEASES_URL =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases'
const RELEASE_LOOKUP_TIMEOUT_MS = 8_000
const MAX_RELEASE_RESPONSE_BYTES = 128

export type ClaudeUpdateChannel = 'stable' | 'latest'

type TextRequester = (url: string) => Promise<string | null>

function requestText(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const settle = (value: string | null): void => {
      if (!settled) {
        settled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        resolve(value)
      }
    }
    const request = get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        settle(null)
        return
      }
      response.setEncoding('utf8')
      let body = ''
      response.on('data', (chunk: string) => {
        body += chunk
        if (Buffer.byteLength(body) > MAX_RELEASE_RESPONSE_BYTES) {
          response.destroy()
          settle(null)
        }
      })
      response.on('end', () => settle(body))
      response.on('error', () => settle(null))
      response.on('aborted', () => settle(null))
    })
    timeout = setTimeout(
      () => request.destroy(new Error('Claude release lookup timed out')),
      RELEASE_LOOKUP_TIMEOUT_MS
    )
    request.on('error', () => settle(null))
  })
}

export async function resolveClaudeLatestVersion(
  channel: ClaudeUpdateChannel,
  requester: TextRequester = requestText
): Promise<string | null> {
  const response = await requester(`${CLAUDE_RELEASES_URL}/${channel}`)
  const version = response?.trim().replace(/^v/i, '') ?? ''
  return isValidAppVersion(version) ? version : null
}
