import type { TerminalInputOrigin } from '../../shared/terminal-input-kind'
import { createTerminalEscapeScanner } from '../../shared/terminal-escape-scanner'
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END
} from '../../shared/terminal-bracketed-paste-text'

/** Retains protocol state and the last submit's author, never the input text. */
export class TerminalSubmitKeys {
  private paste = false
  private author: TerminalInputOrigin | undefined
  private inputAuthor: TerminalInputOrigin = 'programmatic'
  private scanner = this.createScanner()

  interruptPaste(): void {
    this.paste = false
    this.scanner = this.createScanner()
  }

  record(data: string, author: TerminalInputOrigin): void {
    if (data === '\x1b') {
      // A standalone Escape is a complete key, not the start of the next write's sequence.
      this.scanner = this.createScanner()
      return
    }
    this.inputAuthor = author
    this.scanner.observe(data)
  }

  take(): TerminalInputOrigin | undefined {
    const author = this.author
    this.author = undefined
    return author
  }

  private createScanner(): ReturnType<typeof createTerminalEscapeScanner> {
    return createTerminalEscapeScanner({
      onCsi: (privateMarker, params, final) => {
        const sequence = `\x1b[${privateMarker}${params}${final}`
        if (sequence === BRACKETED_PASTE_START) {
          this.paste = true
        } else if (sequence === BRACKETED_PASTE_END) {
          this.paste = false
        } else if (
          !this.paste &&
          privateMarker === '' &&
          final === 'u' &&
          (params === '13' || params === '13;1')
        ) {
          this.author = this.inputAuthor
        }
      },
      onText: (text) => {
        if (!this.paste && text.includes('\r')) {
          this.author = this.inputAuthor
        }
      }
    })
  }
}
