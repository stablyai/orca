import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const MAX_BODY_LENGTH = 65_536
const LOC_START = '<!-- orca-pr-loc -->'
const LOC_END = '<!-- /orca-pr-loc -->'

function inlineCodeIndex(line) {
  const runs = []
  const endAt = new Int32Array(line.length)
  const closeAt = new Int32Array(line.length).fill(-1)
  const nextByLength = new Int32Array(line.length + 1).fill(-1)
  for (let i = 0; i < line.length;) {
    if (line[i] !== '`') {
      i += 1
      continue
    }
    const start = i
    while (line[i] === '`') {
      i += 1
    }
    runs.push(start)
    endAt[start] = i
  }
  // Index once: searching each unmatched run's suffix would be quadratic.
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const start = runs[i]
    const length = endAt[start] - start
    closeAt[start] = nextByLength[length]
    nextByLength[length] = start
  }
  return { endAt, closeAt }
}

function codeLinePrefix(line) {
  let i = 0
  let columns = 0
  while (line[i] === ' ' || line[i] === '\t') {
    columns += line[i] === '\t' ? 4 - (columns % 4) : 1
    i += 1
    if (columns >= 4) {
      return { indented: true }
    }
  }
  const char = line[i]
  if (char !== '`' && char !== '~') {
    return { indented: false }
  }
  const start = i
  while (line[i] === char) {
    i += 1
  }
  return { indented: false, char, length: i - start, tail: line.slice(i) }
}

function* visibleDescriptionLines(body) {
  let hidden
  let fence
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const prefix = codeLinePrefix(line)
    if (fence) {
      if (
        !prefix.indented &&
        prefix.char === fence.char &&
        prefix.length >= fence.length &&
        /^[ \t]*$/.test(prefix.tail)
      ) {
        fence = undefined
      }
      continue
    }
    if (!hidden) {
      if (prefix.indented) {
        continue
      }
      if (prefix.length >= 3 && (prefix.char !== '`' || !prefix.tail.includes('`'))) {
        fence = prefix
        continue
      }
    }
    const code = line.includes('`') ? inlineCodeIndex(line) : undefined
    const chunks = []
    for (let i = 0; i < line.length;) {
      if (hidden) {
        const closer = hidden === 'loc' ? LOC_END : '-->'
        if (line.startsWith(closer, i)) {
          i += closer.length
          hidden = undefined
        } else {
          i += 1
        }
      } else if (code && code.endAt[i] > 0) {
        const end = code.closeAt[i] < 0 ? code.endAt[i] : code.endAt[code.closeAt[i]]
        chunks.push(line.slice(i, end))
        i = end
      } else if (line.startsWith(LOC_START, i)) {
        chunks.push(' ')
        i += LOC_START.length
        hidden = 'loc'
      } else if (line.startsWith('<!--', i)) {
        chunks.push(' ')
        i += 4
        hidden = 'comment'
      } else {
        chunks.push(line[i])
        i += 1
      }
    }
    yield chunks.join('')
  }
}

function headingAt(line) {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(line)
  if (!match) {
    return undefined
  }
  let label = (match[2] ?? '').trim()
  let end = label.length
  while (end > 0 && label[end - 1] === '#') {
    end -= 1
  }
  if (end > 0 && end < label.length && /[ \t]/.test(label[end - 1])) {
    label = label.slice(0, end).trimEnd()
  }
  return { level: match[1].length, label }
}

function normalizeAnswerLine(line) {
  const compact = line.trim().replace(/[ \t]/g, '')
  if (/^(?:\*{3,}|_{3,}|-{3,})$/.test(compact)) {
    return ''
  }
  const text = line
    .trim()
    .replace(/^(?:[-+*]|\d+[.)])(?:[ \t]+|$)/, '')
    .replace(/^\[[ xX]\](?:[ \t]+|$)/, '')
  let start = 0
  let end = text.length
  while (start < end) {
    if (/\s/.test(text[start])) {
      start += 1
    } else if (/\s/.test(text[end - 1]) || '.!,;:?…'.includes(text[end - 1])) {
      end -= 1
    } else if (text[start] === text[end - 1] && '*_`'.includes(text[start])) {
      start += 1
      end -= 1
    } else {
      break
    }
  }
  return text.slice(start, end)
}

export function checkPerformanceSection(body) {
  const text = body ?? ''
  if (text.length > MAX_BODY_LENGTH) {
    return { ok: false, reason: 'too-large' }
  }
  let level
  const answers = []
  for (const line of visibleDescriptionLines(text)) {
    const heading = headingAt(line)
    if (heading) {
      if (level !== undefined && heading.level <= level) {
        break
      }
      if (level === undefined && heading.label.toLowerCase() === 'performance') {
        level = heading.level
      }
    } else if (level !== undefined) {
      const answer = normalizeAnswerLine(line)
      if (answer) {
        answers.push(answer)
      }
    }
  }
  if (level === undefined) {
    return { ok: false, reason: 'missing' }
  }
  const plain = answers.join(' ').replace(/\s+/g, ' ').trim()
  if (!plain) {
    return { ok: false, reason: 'empty' }
  }
  if (/^none,?\s*because[\s.:…_-]*$/i.test(plain)) {
    return { ok: false, reason: 'placeholder' }
  }
  if (answers.every((answer) => /^(?:n\/?a|none|no|nothing|tbd|todo|-+)$/i.test(answer))) {
    return { ok: false, reason: 'no-reason' }
  }
  return { ok: true, reason: 'ok' }
}

function main() {
  const result = checkPerformanceSection(process.env.PR_BODY)
  const diagnostics = {
    missing: 'The PR description has no Performance heading outside code or comments.',
    empty: 'The Performance section has no answer outside code, comments or subheadings.',
    placeholder: 'Finish the Performance section’s “None, because” sentence with a reason.',
    'no-reason': 'Explain the performance impact; a bare N/A, None or TODO is not an assessment.',
    'too-large': 'The description exceeds this checker’s 65,536 UTF-16 code unit limit.'
  }
  const fix =
    'Use a ## Performance section with a completed answer, such as None, because <reason>. Editing the description runs this check again when workflows are permitted.'
  const snapshot =
    'This advisory result checks the event’s body snapshot. Review the current Performance answer after automated body updates finish; a green result does not assess the reasoning.'
  const action = ['opened', 'edited', 'reopened', 'synchronize'].includes(
    process.env.PR_EVENT_ACTION
  )
    ? process.env.PR_EVENT_ACTION
    : 'pull request'
  const head = /^[a-f\d]{40}$/i.test(process.env.PR_HEAD_SHA ?? '')
    ? process.env.PR_HEAD_SHA
    : 'unknown'
  const message = result.ok
    ? 'The event snapshot has a completed Performance answer.'
    : diagnostics[result.reason]
  if (!result.ok) {
    console.log(`::error::${message} ${fix}`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Performance section\n\n${message}\n\n${result.ok ? '' : `${fix}\n\n`}${snapshot}\n\nEvent: ${action}; head: ${head}.\n`
    )
  }
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
