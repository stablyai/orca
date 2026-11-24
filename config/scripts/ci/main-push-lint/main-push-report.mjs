// Render main-push lint results as one-line log text and bounded Markdown; paths and tool output are untrusted.
// GitHub rejects step summaries over 1 MiB, so each section has a byte budget and says what it left out.
const FAILURE_TABLE_BYTES = 384 * 1024
const ATTRIBUTION_TABLE_BYTES = 192 * 1024
const MAX_CELL_CHARS = 500
const MAX_EXCERPT_CHARS = 2_000
const MAX_INCOMPLETE_SHOWN = 5
const MAX_PATHS_SHOWN = 10

export function truncate(value, maxChars) {
  return value.length > maxChars
    ? `${value.slice(0, maxChars)}… (${value.length - maxChars} more characters)`
    : value
}

// One line, with control characters shown as \uXXXX, so a value can never start a new log line or workflow command.
export function visibleText(value) {
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what this escapes.
  return String(value).replace(/[\\\u0000-\u001f\u007f\u2028\u2029]/g, (char) =>
    char === '\\' ? '\\\\' : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

// ASCII punctuation becomes numeric entities, so no character can open Markdown, HTML or a table cell.
export function markdownText(value) {
  return visibleText(truncate(String(value), MAX_CELL_CHARS)).replace(
    /[!-,:-@[-`{-~]/g,
    (char) => `&#${char.charCodeAt(0)};`
  )
}

function markdownCode(value) {
  return `<code>${markdownText(value)}</code>`
}

// Inside <pre> Markdown is off; escaping <, > and & keeps tool output from closing the block.
function preformatted(value) {
  const text = truncate(value.trim(), MAX_EXCERPT_CHARS)
  return `<pre>\n${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\n</pre>`
}

export function describeLocation(diagnostic) {
  return diagnostic.file ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.col}` : '(no file)'
}

// The runner reads a line that starts with `::` or contains `##[` as a workflow command, so a path
// such as `::stop-commands::x.ts` must not reach the log as one.
export function logText(value) {
  return visibleText(value)
    .replace(/^( *):/, (_, spaces) => `${spaces}\\u003a`)
    .replaceAll('##[', '##\\u005b')
}

export function logLine(diagnostic) {
  return logText(`${describeLocation(diagnostic)} ${diagnostic.rule} ${diagnostic.message}`)
}

// Escape a value for the data part of a workflow command (`::error ...::<data>`).
export function escapeAnnotationData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

export function escapeAnnotationProperty(value) {
  return escapeAnnotationData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

// Render rows only until the byte budget is spent, so a huge failure costs no more than the rows shown.
function boundedRows(items, renderRow, maxBytes) {
  const shown = []
  let bytes = 0
  for (const item of items) {
    const row = renderRow(item)
    bytes += Buffer.byteLength(row) + 1
    if (bytes > maxBytes) {
      break
    }
    shown.push(row)
  }
  return { shown, omitted: items.length - shown.length }
}

function coverageLine({ candidates, linted, incomplete }) {
  const skipped = incomplete.reduce((total, batch) => total + batch.files.length, 0)
  const ignored =
    skipped === 0 && linted < candidates
      ? ` (oxlint's ignorePatterns skipped ${candidates - linted})`
      : ''
  const partial =
    skipped > 0
      ? `; ${skipped} candidate(s) were in oxlint runs that did not finish, so coverage is incomplete`
      : ''
  return `oxlint linted ${linted} of ${candidates} changed candidate file(s)${ignored}${partial}.`
}

export function renderLintSummary({ range, scope, candidates, linted, diagnostics, incomplete }) {
  const header = `Range ${markdownCode(range)}: ${scope}. ${coverageLine({ candidates, linted, incomplete })}`
  if (diagnostics.length === 0 && incomplete.length === 0) {
    return `### Main-push lint passed\n\n${header}\n`
  }
  const lines = ['### Main-push lint failed', '', header, '']
  if (diagnostics.length > 0) {
    const { shown, omitted } = boundedRows(
      diagnostics,
      (diagnostic) =>
        `| ${markdownCode(describeLocation(diagnostic))} | ${markdownCode(diagnostic.rule)} | ${markdownText(diagnostic.message)} |`,
      FAILURE_TABLE_BYTES
    )
    lines.push(
      `${diagnostics.length} oxlint error(s). PR checks lint against an older main, so a merge can cross a limit there; fix it on main.`,
      '',
      '| Location | Rule | Message |',
      '| --- | --- | --- |',
      ...shown,
      ''
    )
    if (omitted > 0) {
      lines.push(`${omitted} more error(s) are not shown here; the step log lists them.`, '')
    }
  }
  for (const batch of incomplete.slice(0, MAX_INCOMPLETE_SHOWN)) {
    const paths = batch.files.slice(0, MAX_PATHS_SHOWN).map(markdownCode).join(', ')
    const more =
      batch.files.length > MAX_PATHS_SHOWN
        ? ` and ${batch.files.length - MAX_PATHS_SHOWN} more`
        : ''
    lines.push(
      `#### oxlint did not finish ${batch.files.length} file(s): ${paths}${more}`,
      '',
      preformatted(batch.output),
      ''
    )
  }
  if (incomplete.length > MAX_INCOMPLETE_SHOWN) {
    lines.push(
      `${incomplete.length - MAX_INCOMPLETE_SHOWN} more unfinished oxlint run(s) are in the step log.`,
      ''
    )
  }
  return lines.join('\n')
}

export function renderAttributionSummary(rows) {
  const { shown, omitted } = boundedRows(
    rows,
    ({ file, description }) => `| ${markdownCode(file)} | ${markdownText(description)} |`,
    ATTRIBUTION_TABLE_BYTES
  )
  return [
    '#### Commits in this push that changed each failing file',
    '',
    'Newest first. The error may predate them if the file already failed before this push; older revisions are not linted.',
    '',
    '| File | Changed in this push by |',
    '| --- | --- |',
    ...shown,
    '',
    ...(omitted > 0
      ? [`${omitted} more file(s) are not shown here; the step log lists them.`, '']
      : [])
  ].join('\n')
}
