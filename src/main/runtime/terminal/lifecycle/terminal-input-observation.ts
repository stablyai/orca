import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END
} from '../../../../shared/terminal/input/terminal-bracketed-paste-text'

export type TerminalInputScreen = { draft: string | null; lines: readonly string[]; model?: object }
export type TerminalInputScreenReader = (ptyId: string) => Promise<TerminalInputScreen>
const unknownScreen: TerminalInputScreen = { draft: null, lines: [] }
const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')
// Keep prompt glyphs escaped for the ASCII-only daemon bundle.
const PROMPT_LINE = new RegExp(String.raw`^\s*[\u276f\u203a\u00bb]\s?(.*)$`)
const PROMPT_PREFIX = new RegExp(String.raw`^\s*[\u276f\u203a\u00bb]`)

type Pending = {
  revision: number
  raw: string
  before: Promise<TerminalInputScreen>
  effect?: ReturnType<typeof inputEffect>
}

function inputEffect(
  raw: string,
  draft: string | null
): { draft: string; submitted: string | null } | null {
  let text = draft ?? ''
  let submitted: string | null = null
  let paste = false
  let known = true
  for (let index = 0; index < raw.length; index += 1) {
    if (raw.startsWith(BRACKETED_PASTE_START, index)) {
      paste = true
      index += BRACKETED_PASTE_START.length - 1
      continue
    }
    if (raw.startsWith(BRACKETED_PASTE_END, index)) {
      paste = false
      index += BRACKETED_PASTE_END.length - 1
      continue
    }
    const char = raw[index]
    if (char === '\x15' && !paste) {
      text = ''
      submitted = null
      known = true
    } else if ((char === '\x7f' || char === '\b') && !paste) {
      text = [...text].slice(0, -1).join('')
      submitted = null
    } else if ((char === '\r' || char === '\n') && !paste) {
      submitted = known && text.trim() ? text : null
      text = ''
    } else if (char === '\r' || char === '\n' || (paste && char === '\t') || char >= ' ') {
      text += char
      submitted = null
    } else {
      known = false
      submitted = null
    }
  }
  return known && !paste ? { draft: text, submitted } : null
}

function echoCount(lines: readonly string[], text: string): number {
  const expected = normalize(text)
  let count = 0
  for (let index = 0; index < lines.length; index += 1) {
    const prompt = PROMPT_LINE.exec(lines[index])
    if (!prompt) {
      continue
    }
    let echo = normalize(prompt[1])
    for (let next = index + 1; echo.length < expected.length && next < lines.length; next += 1) {
      if (!expected.startsWith(echo) || PROMPT_PREFIX.test(lines[next])) {
        break
      }
      echo = normalize(`${echo} ${lines[next]}`)
    }
    if (echo === expected) {
      count += 1
    }
  }
  return count
}

/** A writer's effect must paint, rather than merely share a chunk with unrelated output. */
export class TerminalInputObservation {
  private readonly pending = new Map<string, Pending>()
  private reader: TerminalInputScreenReader = async () => unknownScreen

  setReader(reader: TerminalInputScreenReader): void {
    this.reader = reader
  }
  needsScreen(ptyId: string): boolean {
    const pending = this.pending.get(ptyId)
    return pending !== undefined && pending.effect !== null
  }
  hasPending(ptyId: string): boolean {
    return this.pending.has(ptyId)
  }
  delete(ptyId: string): void {
    this.pending.delete(ptyId)
  }

  record(ptyId: string, revision: number, data: string): void {
    const pending = this.pending.get(ptyId)
    if (pending) {
      pending.revision = revision
      pending.effect = undefined
      pending.raw = pending.raw.length + data.length <= 65_536 ? pending.raw + data : '\x00'
    } else {
      // Capture the current parse chain before provider.write can synchronously produce output.
      let before: Promise<TerminalInputScreen>
      try {
        before = this.reader(ptyId).catch(() => unknownScreen)
      } catch {
        before = Promise.resolve(unknownScreen)
      }
      this.pending.set(ptyId, { revision, raw: data.length <= 65_536 ? data : '\x00', before })
    }
  }

  async observe(ptyId: string, after: Promise<TerminalInputScreen>): Promise<void> {
    const pending = this.pending.get(ptyId)
    if (!pending) {
      return
    }
    const revision = pending.revision
    const [before, screen] = await Promise.all([pending.before, after])
    if (this.pending.get(ptyId) !== pending || pending.revision !== revision) {
      return
    }
    if (before.draft === null || before.model !== screen.model) {
      pending.effect = null
      return
    }
    if (screen.draft === null) {
      return
    }
    if (pending.effect === undefined) {
      pending.effect = inputEffect(pending.raw, before.draft)
    }
    const effect = pending.effect
    if (!effect) {
      return
    }
    const changedDraft =
      effect.submitted === null && effect.draft !== before.draft && screen.draft === effect.draft
    const submitted =
      effect.submitted !== null &&
      echoCount(screen.lines, effect.submitted) > echoCount(before.lines, effect.submitted)
    const submittedComposerCleared =
      effect.submitted !== null &&
      before.draft === effect.submitted &&
      effect.draft === '' &&
      screen.draft === ''
    if (changedDraft || submitted || submittedComposerCleared) {
      this.pending.delete(ptyId)
    }
  }
}
