import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { isCodexLoginAuthUrl } from './codex-login-auth-url'

const CODE_MARKER = 'one-time code'
// Why: codex's device code stays valid for 15 minutes, and its page is opened on another device.
export const DEVICE_AUTH_TIMEOUT_MS = 900_000

/**
 * The page and one-time code `codex login --device-auth` prints, or null until both are complete.
 * Only OpenAI's own page counts, and the code must follow its marker line, so an update notice's
 * link is never offered in its place.
 */
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
  // Why trailing whitespace: output arrives in chunks, and a cut code would sign in nothing.
  const code = /^\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s/.exec(afterMarkerLine)
  if (!url || !code || afterMarkerLine === plain.slice(markerIndex)) {
    return null
  }
  return { url: new URL(url).toString(), userCode: code[1] }
}
