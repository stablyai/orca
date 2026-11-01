// Detect terminal password/secret prompts and format asterisk ('*') masks for mobile input fields.

const PASSWORD_PROMPT_LINE_PATTERN =
  /(?:^|[\s[\]()>-])(?:sudo\s+password(?:\s+for\s+[^\r\n:]+)?|password(?:\s+for\s+[^\r\n:]+)?|enter\s+passphrase(?:\s+for\s+[^\r\n:]+)?|passphrase(?:\s+for\s+[^\r\n:]+)?|enter\s+pin(?:\s+for\s+[^\r\n:]+)?|pin\s+code|verification\s+code|one-time\s+password)\s*:\s*$/i

const MAX_PROMPT_TAIL_CHARS = 512

export function stripTerminalPromptAnsi(raw: string): string {
  let out = ''
  let i = 0
  while (i < raw.length) {
    const code = raw.charCodeAt(i)
    if (code === 0x1b) {
      const next = raw.charCodeAt(i + 1)
      if (next === 0x5d) {
        // OSC sequence: ESC ] ... BEL (0x07) or ST (ESC \)
        i += 2
        while (i < raw.length) {
          const c = raw.charCodeAt(i)
          if (c === 0x07) {
            i += 1
            break
          }
          if (c === 0x1b && raw.charCodeAt(i + 1) === 0x5c) {
            i += 2
            break
          }
          i += 1
        }
        continue
      }
      if (next === 0x5b) {
        // CSI sequence: ESC [ ... final byte 0x40-0x7e
        i += 2
        while (i < raw.length) {
          const c = raw.charCodeAt(i)
          i += 1
          if (c >= 0x40 && c <= 0x7e) {
            break
          }
        }
        continue
      }
      // Two-byte escape sequence
      i += 2
      continue
    }
    out += raw[i]
    i += 1
  }
  return out
}

export function extractTerminalPromptCandidateLine(rawTail: string): string {
  const clean = stripTerminalPromptAnsi(rawTail)
  const lines = clean.split('\n')
  const lastLine = lines[lines.length - 1] ?? ''
  // Carriage returns overwrite the current line in place unless followed by a newline.
  const segments = lastLine.split('\r')
  return segments[segments.length - 1] ?? ''
}

export function isTerminalPasswordPromptText(rawTail: string): boolean {
  if (!rawTail) {
    return false
  }
  const candidate = extractTerminalPromptCandidateLine(rawTail)
  if (!candidate || candidate.length > 240) {
    return false
  }
  return PASSWORD_PROMPT_LINE_PATTERN.test(candidate)
}

export function appendTerminalPromptTail(previousTail: string, chunk: string): string {
  const combined = previousTail + chunk
  return combined.length > MAX_PROMPT_TAIL_CHARS
    ? combined.slice(combined.length - MAX_PROMPT_TAIL_CHARS)
    : combined
}

export function maskTerminalLiveInputText(text: string): string {
  if (!text) {
    return ''
  }
  return '*'.repeat(Array.from(text).length)
}

export function resolveTerminalInputMaskedState(options: {
  readonly autoDetectedPrompt: boolean
  readonly manualOverride: boolean | undefined
}): boolean {
  return options.manualOverride ?? options.autoDetectedPrompt
}
