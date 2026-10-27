import { StringDecoder } from 'node:string_decoder'
import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'
import { redactString } from '../../shared/secret-redaction'

const PEM_MARKER = /-----(BEGIN|END) [A-Z ]+-----/g

/** A byte-bounded stderr tail whose text is redacted for display. */
export function createProviderStderrTail(maxBytes: number) {
  const output = createOutputSink(maxBytes, 'tail')
  const decoder = new StringDecoder('utf8')
  // Tail capture keeps the last PEM marker of an overlong line.
  let line = createOutputSink(maxBytes, 'tail')
  let insidePem = false

  // Cut lines and PEM blocks are omitted: neither can be redacted reliably line by line.
  const finishLine = (separator: string): void => {
    const text = stripAnsiControlSequences(line.text())
    let omit = insidePem || line.truncated()
    for (const marker of text.matchAll(PEM_MARKER)) {
      insidePem = marker[1] === 'BEGIN'
      omit = true
    }
    if (!omit) {
      output.write(text + separator)
    }
    line = createOutputSink(maxBytes, 'tail')
  }

  return {
    write(chunk: Buffer | string): void {
      const text = decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      const parts = text.split(/(\r\n|[\r\n\u2028\u2029])/)
      for (let index = 0; index < parts.length; index += 2) {
        // One excess character still marks overflow without encoding a giant part.
        line.write(parts[index].slice(-(maxBytes + 1)))
        const separator = parts[index + 1]
        if (separator !== undefined) {
          finishLine(separator)
        }
      }
    },
    text(): string {
      const pending = stripAnsiControlSequences(line.text())
      const visiblePending =
        insidePem || line.truncated() || pending.includes('-----BEGIN ') ? '' : pending
      const redacted = createOutputSink(maxBytes, 'tail')
      redacted.write(
        redactString(discardPartialLine(output.text(), output.truncated()) + visiblePending)
      )
      return discardPartialLine(redacted.text(), redacted.truncated())
    }
  }
}

// A truncated line may have lost the label needed to redact a secret.
function discardPartialLine(text: string, truncated: boolean): string {
  return truncated ? text.replace(/^[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)/, '') : text
}
