// What an IM may show of a turn, which others in a group or on the platform may read, never only
// the machine's owner. Thinking and tool input are masked hard; an answer keeps its prose.
import { BOT_TEXT_LEFT_OUT, redactBotText } from '../../shared/bots/bot-text-scan'
import { redactString } from '../../shared/observability/redactor'

// `KEY=value cmd`, `export KEY="x"`: an assignment's value never shows, whatever its name says.
const ASSIGNMENT =
  /(^|[\s;&|(])((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g
// A URL's userinfo (whatever stands between `scheme://` and `@host`) never shows.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi

/** Values alone: assignments and URL credentials lose theirs, key shapes are masked. Safe before a
 *  cut, since no line is judged yet. */
export function maskImValues(text: string): string {
  return redactString(text.replace(URL_CREDENTIALS, '$1…@').replace(ASSIGNMENT, '$1$2=…'))
}

/** Thinking or tool input bound for an IM: values masked, and each line that still looks like it
 *  holds a secret shown as `…`; with how many were. */
export function maskImLines(text: string): { text: string; leftOut: number } {
  const { text: shown, leftOut } = redactBotText(maskImValues(text))
  return { text: shown.split(BOT_TEXT_LEFT_OUT).join('…'), leftOut }
}

export function maskImText(text: string): string {
  return maskImLines(text).text
}

/** An answer as an IM reader sees it: known key shapes masked. Prose stays whole, since an answer
 *  naturally says "the token is …" where a tool input or thought would leak one. Mask the final
 *  answer with this too, so it shows no key its progress hid. */
export function imAnswerText(text: string): string {
  return redactString(text)
}
