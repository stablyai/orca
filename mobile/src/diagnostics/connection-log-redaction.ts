import type { ConnectionLogEntry } from '../transport/types'

const SECRET_JSON_ASSIGNMENT =
  /(["'])(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)\1(\s*:\s*)(["'])(?:Bearer\s+)?(?:\\.|(?!\4)[^\\\r\n])*\4/gi
const SECRET_QUOTED_VALUE_ASSIGNMENT =
  /\b(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)(\s*[:=]\s*)(["'])(?:Bearer\s+)?(?:\\.|(?!\3)[^\\\r\n])*\3/gi
const SECRET_UNTERMINATED_JSON_ASSIGNMENT =
  /(["'])(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)\1(\s*:\s*)(["'])(?:Bearer\s+)?(?:\\.|(?!\4)[^\\\r\n])*(?=\r?\n|$)/gi
const SECRET_UNTERMINATED_QUOTED_VALUE_ASSIGNMENT =
  /\b(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)(\s*[:=]\s*)(["'])(?:Bearer\s+)?(?:\\.|(?!\3)[^\\\r\n])*(?=\r?\n|$)/gi
const SECRET_ASSIGNMENT =
  /\b(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)(\s*[:=]\s*)(?:Bearer\s+)?([^\s;,}"']+)/gi
const SECRET_QUERY = /([?&](?:token|credential|resumeToken|deviceToken)=)[^&#\s]+/gi
const URL_USERINFO = /((?:wss?|https?):\/\/)[^\s/?#]*@/gi

export function redactConnectionLogText(value: string): string {
  return value
    .replace(
      SECRET_JSON_ASSIGNMENT,
      (_match, keyQuote: string, label: string, separator: string, valueQuote: string) =>
        `${keyQuote}${label}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`
    )
    .replace(
      SECRET_QUOTED_VALUE_ASSIGNMENT,
      (_match, label: string, separator: string, valueQuote: string) =>
        `${label}${separator}${valueQuote}[redacted]${valueQuote}`
    )
    .replace(
      SECRET_UNTERMINATED_JSON_ASSIGNMENT,
      (_match, keyQuote: string, label: string, separator: string, valueQuote: string) =>
        `${keyQuote}${label}${keyQuote}${separator}${valueQuote}[redacted]`
    )
    .replace(
      SECRET_UNTERMINATED_QUOTED_VALUE_ASSIGNMENT,
      (_match, label: string, separator: string, valueQuote: string) =>
        `${label}${separator}${valueQuote}[redacted]`
    )
    .replace(SECRET_ASSIGNMENT, (_match, label: string, separator: string) => {
      return `${label}${separator}[redacted]`
    })
    .replace(SECRET_QUERY, '$1[redacted]')
    .replace(URL_USERINFO, '$1[redacted]@')
}

export function redactConnectionLogEntry(entry: ConnectionLogEntry): ConnectionLogEntry {
  return {
    ...entry,
    message: redactConnectionLogText(entry.message),
    ...(entry.detail ? { detail: redactConnectionLogText(entry.detail) } : {})
  }
}
