// Render main-push lint results as one-line log text and bounded Markdown; paths and tool output are untrusted.
// GitHub rejects step summaries over 1 MiB, so each section has a byte budget and says what it left out.
const FAILURE_TABLE_BYTES = 384 * 1024
const ATTRIBUTION_TABLE_BYTES = 192 * 1024
const MAX_CELL_CHARS = 500
const MAX_EXCERPT_CHARS = 2_000
export const MAX_LOG_LINE_CHARS = 1_000
const MAX_INCOMPLETE_SHOWN = 5
const MAX_PATHS_SHOWN = 10
const MAX_LISTED = 10

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

export function markdownCode(value) {
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
export function logText(value, maxChars = Number.POSITIVE_INFINITY) {
  return visibleText(truncate(String(value), maxChars))
    .replace(/^( *):/, (_, spaces) => `${spaces}\\u003a`)
    .replaceAll('##[', '##\\u005b')
}

export function logLine(diagnostic, maxChars = MAX_LOG_LINE_CHARS) {
  return logText(
    `${describeLocation(diagnostic)} ${diagnostic.rule} ${diagnostic.message}`,
    maxChars
  )
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

// Where the log stops, so an omission note never points at rows the log also left out.
function logNote(total, logged, noun) {
  return logged >= total
    ? `the step log lists every ${noun}`
    : `the step log lists the first ${logged} of ${total}`
}

// At most MAX_LISTED items, then a count of the rest, so a long list cannot crowd out the result tables.
function listed(items, render) {
  const shown = items.slice(0, MAX_LISTED).map(render).join('; ')
  return items.length > MAX_LISTED ? `${shown}; and ${items.length - MAX_LISTED} more` : shown
}

function coverageLine({ candidates, dirs, linted, incomplete }) {
  const walked =
    dirs.length > 0 ? `, plus every lintable file under ${listed(dirs, markdownCode)}` : ''
  const unfinished = incomplete.reduce((total, batch) => total + batch.files.length, 0)
  const partial =
    unfinished > 0
      ? `; ${unfinished} path(s) were in oxlint runs that did not finish, so coverage is incomplete`
      : ''
  // oxlint does not say which explicit paths it excluded or why, so neither does this.
  const excluded =
    dirs.length === 0 && unfinished === 0 && linted < candidates
      ? ` oxlint excluded the other ${candidates - linted} itself.`
      : ''
  return `Planned: ${candidates} changed candidate file(s)${walked}. oxlint reported linting ${linted} file(s)${partial}.${excluded}`
}

function policyLine(policies) {
  return policies.length > 0
    ? `Lint policy changed, so the whole scope it governs is linted: ${listed(policies, (policy) => markdownText(policy.why))}.`
    : ''
}

export function renderLintSummary({
  range,
  scope,
  candidates,
  dirs = [],
  policies = [],
  linted,
  diagnostics,
  incomplete,
  loggedDiagnostics = diagnostics.length,
  loggedIncomplete = incomplete.length
}) {
  const header = [
    `Range ${markdownCode(range)}: ${scope}. ${coverageLine({ candidates, dirs, linted, incomplete })}`,
    policyLine(policies)
  ]
    .filter(Boolean)
    .join('\n\n')
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
      lines.push(
        `${omitted} more error(s) are not shown here; ${logNote(diagnostics.length, loggedDiagnostics, 'error')}.`,
        ''
      )
    }
  }
  for (const batch of incomplete.slice(0, MAX_INCOMPLETE_SHOWN)) {
    const paths = batch.files.slice(0, MAX_PATHS_SHOWN).map(markdownCode).join(', ')
    const more =
      batch.files.length > MAX_PATHS_SHOWN
        ? ` and ${batch.files.length - MAX_PATHS_SHOWN} more`
        : ''
    lines.push(
      `#### oxlint did not finish ${batch.files.length} path(s) (${markdownText(batch.reason)}): ${paths}${more}`,
      '',
      preformatted(batch.output || '(no output)'),
      ''
    )
  }
  if (incomplete.length > MAX_INCOMPLETE_SHOWN) {
    lines.push(
      `${incomplete.length - MAX_INCOMPLETE_SHOWN} more unfinished oxlint run(s) are not shown here; ${logNote(incomplete.length, loggedIncomplete, 'unfinished run')}.`,
      ''
    )
  }
  return lines.join('\n')
}

export function renderAttributionSummary(rows, { noun = 'this push', logged = rows.length } = {}) {
  const { shown, omitted } = boundedRows(
    rows,
    ({ file, description }) => `| ${markdownCode(file)} | ${markdownText(description)} |`,
    ATTRIBUTION_TABLE_BYTES
  )
  return [
    `#### Commits in ${noun} that changed each failing file`,
    '',
    `Newest first. The error may predate them if the file already failed before ${noun}; older revisions are not linted.`,
    '',
    `| File | Changed in ${noun} by |`,
    '| --- | --- |',
    ...shown,
    '',
    ...(omitted > 0
      ? [`${omitted} more file(s) are not shown here; ${logNote(rows.length, logged, 'file')}.`, '']
      : [])
  ].join('\n')
}
