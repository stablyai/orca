import { executeFastJevCompaction } from './terminal-compaction'

export {
  compactTerminalHeuristic,
  executeFastJevCompaction,
  parseTerminalToMessages,
  renderMessagesHuman,
  type CompactTerminalOptions
} from './terminal-compaction'

export type FormatTerminalHumanOptions = {
  /** If true, output raw input without any formatting or compaction. */
  raw?: boolean
  /** If true, perform fast-jev semantic compaction on conversation & tool outputs. */
  compact?: boolean
  /** Maximum lines of identical repetitive output before folding into a summary line. Default: 3 */
  repetitionThreshold?: number
  /** Maximum length of tool results retained when compacted without Jev API key. Default: 200 */
  truncateHeadChars?: number
}

/* oxlint-disable no-control-regex */
// Strip OSC sequences (e.g. window title changes)
const OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// Strip ANSI control and CSI sequences (colors, cursor moves, clear screen, etc.)
const CSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/* oxlint-enable no-control-regex */

/**
 * Strips ANSI control characters, OSC title codes, and resolves carriage returns (\r).
 */
export function stripAnsiAndCarriageReturns(text: string): string {
  const noOsc = text.replace(OSC_REGEX, '')
  const lines = noOsc.split('\n')
  const resolvedLines = lines.map((line) => {
    if (!line.includes('\r')) {
      return line.replace(CSI_REGEX, '')
    }
    const parts = line.split('\r')
    let lastValid = ''
    for (let i = parts.length - 1; i >= 0; i--) {
      const cleaned = parts[i].replace(CSI_REGEX, '').trimEnd()
      if (cleaned.length > 0) {
        lastValid = cleaned
        break
      }
    }
    return lastValid
  })
  return resolvedLines.join('\n')
}

/**
 * Folds runs of identical or near-identical repetitive lines.
 */
export function foldRepetitiveLines(lines: string[], threshold = 3): string[] {
  if (lines.length <= threshold) {
    return lines
  }
  const result: string[] = []
  let currentLine: string | null = null
  let count = 0

  const flush = () => {
    if (currentLine === null) {
      return
    }
    if (count === 1) {
      result.push(currentLine)
    } else if (count < threshold) {
      for (let i = 0; i < count; i++) {
        result.push(currentLine)
      }
    } else {
      result.push(currentLine)
      const preview = currentLine.trim().slice(0, 40)
      result.push(
        `  · · · [repeated ${count - 1} more times: "${preview}${currentLine.trim().length > 40 ? '...' : ''}"] · · ·`
      )
    }
    currentLine = null
    count = 0
  }

  for (const line of lines) {
    if (line === currentLine) {
      count++
    } else {
      flush()
      currentLine = line
      count = 1
    }
  }
  flush()
  return result
}

/**
 * Nicely frames code blocks and diffs with box characters for human reading.
 */
export function formatCodeAndDiffBlocks(lines: string[]): string[] {
  const output: string[] = []
  let inCodeBlock = false
  let codeLang = ''
  let codeLines: string[] = []

  let inDiffBlock = false
  let diffFile = ''
  let diffLines: string[] = []

  const flushCodeBlock = () => {
    if (!inCodeBlock) {
      return
    }
    const langBadge = codeLang ? ` [${codeLang}] ` : ' [Code] '
    const headerTitle = `╭──${langBadge}`
    const ruleLen = Math.max(0, 72 - headerTitle.length)
    output.push(`${headerTitle}${'─'.repeat(ruleLen)}`)
    const padLen = String(codeLines.length).length
    codeLines.forEach((codeLine, idx) => {
      const lineNum = String(idx + 1).padStart(padLen, ' ')
      output.push(`│ ${lineNum} │ ${codeLine}`)
    })
    output.push(`╰${'─'.repeat(71)}`)
    inCodeBlock = false
    codeLang = ''
    codeLines = []
  }

  const flushDiffBlock = () => {
    if (!inDiffBlock) {
      return
    }
    const fileBadge = diffFile ? ` Diff: ${diffFile} ` : ' Diff '
    const headerTitle = `╭──${fileBadge}`
    const ruleLen = Math.max(0, 72 - headerTitle.length)
    output.push(`${headerTitle}${'─'.repeat(ruleLen)}`)
    diffLines.forEach((diffLine) => {
      output.push(`│ ${diffLine}`)
    })
    output.push(`╰${'─'.repeat(71)}`)
    inDiffBlock = false
    diffFile = ''
    diffLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const codeBlockMatch = line.match(/^```(\w+)?/)
    if (codeBlockMatch && !inDiffBlock) {
      if (inCodeBlock) {
        flushCodeBlock()
      } else {
        inCodeBlock = true
        codeLang = codeBlockMatch[1] || ''
      }
      continue
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    const diffGitMatch = line.match(/^diff --git a\/(.+) b\/(.+)/)
    if (diffGitMatch) {
      if (inDiffBlock) {
        flushDiffBlock()
      }
      inDiffBlock = true
      diffFile = diffGitMatch[2]
      diffLines.push(line)
      continue
    }

    if (inDiffBlock) {
      if (
        line.startsWith('@@') ||
        line.startsWith('+') ||
        line.startsWith('-') ||
        line.startsWith(' ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ')
      ) {
        diffLines.push(line)
        continue
      }
      flushDiffBlock()
    }

    output.push(line)
  }

  if (inCodeBlock) {
    flushCodeBlock()
  }
  if (inDiffBlock) {
    flushDiffBlock()
  }

  return output
}

/**
 * Master human-readable formatter for terminal outputs.
 */
export async function formatTerminalHuman(
  input: string | string[],
  options: FormatTerminalHumanOptions = {}
): Promise<string> {
  const rawText = Array.isArray(input) ? input.join('\n') : input
  if (options.raw) {
    return rawText
  }

  const cleanedText = stripAnsiAndCarriageReturns(rawText)
  const rawLines = cleanedText.split('\n')

  if (options.compact) {
    const { lines: compactedLines, summary } = await executeFastJevCompaction(rawLines, {
      compact: true,
      truncateHeadChars: options.truncateHeadChars
    })
    const formatted = formatCodeAndDiffBlocks(
      foldRepetitiveLines(compactedLines, options.repetitionThreshold ?? 3)
    )
    return summary ? `${summary}\n\n${formatted.join('\n')}` : formatted.join('\n')
  }

  const folded = foldRepetitiveLines(rawLines, options.repetitionThreshold ?? 3)
  const formatted = formatCodeAndDiffBlocks(folded)
  return formatted.join('\n')
}
