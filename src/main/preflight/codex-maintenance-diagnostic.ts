import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../shared/ansi-escape-sequences'
import { stripCredentialsFromMessage } from '../../shared/git-remote-error'

export function codexMaintenanceDiagnostic(error: string): string {
  return stripCredentialsFromMessage(stripAnsiEscapeSequences(error))
    .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, ' ')
    .replace(
      /((?:authorization|password|token|api[-_]?key)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;&]+/gi,
      '$1[redacted]'
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1024)
}
