import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { isCodexLoginAuthUrl } from './codex-login-auth-url'

const CODE_MARKER = 'one-time code'
// Match Codex's 15-minute device-code validity window.
export const DEVICE_AUTH_TIMEOUT_MS = 900_000

/** Wait for a complete OpenAI device link and a code following its marker. */
export function parseCodexDeviceAuthPrompt(
  output: string
): { url: string; userCode: string } | null {
  const plain = stripAnsiEscapeSequences(output)
  const markerIndex = plain.toLowerCase().indexOf(CODE_MARKER)
  if (markerIndex === -1) {
    return null
  }
  const url = [...plain.slice(0, markerIndex).matchAll(/https:\/\/\S+/g)]
    .map((match) => match[0])
    .find(isCodexLoginAuthUrl)
  const afterMarkerLine = plain.slice(markerIndex).replace(/^[^\n]*\n/, '')
  // Trailing whitespace proves the streamed code is complete.
  const code = /^\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s/.exec(afterMarkerLine)
  if (!url || !code || afterMarkerLine === plain.slice(markerIndex)) {
    return null
  }
  return { url: new URL(url).toString(), userCode: code[1] }
}
