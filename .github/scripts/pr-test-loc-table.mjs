export const LOC_BLOCK_START = '<!-- orca-pr-loc -->'
export const LOC_BLOCK_END = '<!-- /orca-pr-loc -->'
export const LOC_HANDS_OFF_COMMENT =
  '<!-- Programmatic LoC summary. Do not edit by hand; rewritten on every commit. -->'

// Why the __-wrapped names: they are unambiguous test-data markers, so a dir
// cannot be one by accident. Bare `fixtures/` is deliberately absent — it reads
// as a plausible prod module name, and this classifier bills every PR.
const TEST_DIR_SEGMENT = /(?:^|\/)(?:__tests__|__fixtures__|__snapshots__|e2e|tests)(?:\/|$)/i
const TEST_FILENAME = /\.(?:test|spec|e2e)\.[^/]+$/i

export function isTestPath(path) {
  const normalized = path.replaceAll('\\', '/')
  return TEST_DIR_SEGMENT.test(normalized) || TEST_FILENAME.test(normalized)
}

export function emptyLocTotals() {
  return {
    test: { files: 0, added: 0, deleted: 0 },
    nonTest: { files: 0, added: 0, deleted: 0 }
  }
}

export function sumChangedFiles(files) {
  const totals = emptyLocTotals()
  for (const file of files) {
    const path = file.filename
    if (path == null) {
      continue
    }
    const bucket = isTestPath(path) ? totals.test : totals.nonTest
    bucket.files += 1
    bucket.added += Number(file.additions ?? 0)
    bucket.deleted += Number(file.deletions ?? 0)
  }
  return totals
}

const COLOR_ADDED = '#1a7f37'
const COLOR_DELETED = '#cf222e'

function diffCell(count) {
  if (count === 0) {
    return '0'
  }
  if (count > 0) {
    return `$\\color{${COLOR_ADDED}}{\\Huge{\\mathbf{+}}}$\u200b${count}`
  }
  return `$\\color{${COLOR_DELETED}}{\\Huge{\\mathbf{−}}}$\u200b${Math.abs(count)}`
}

function locTableRow(label, bucket) {
  const added = bucket.added ?? 0
  const deleted = bucket.deleted ?? 0
  return `| ${label} | ${bucket.files ?? 0} | ${diffCell(added)} | ${diffCell(-deleted)} | ${diffCell(added - deleted)} |`
}

export function formatLocTable({ test, nonTest }) {
  return [
    '| | Files | Added | Deleted | Net |',
    '| :--- | ---: | ---: | ---: | ---: |',
    locTableRow('Test', test),
    locTableRow('Prod', nonTest)
  ].join('\n')
}

export function renderLocBlock(totals) {
  return [
    LOC_BLOCK_START,
    LOC_HANDS_OFF_COMMENT,
    '',
    formatLocTable(totals),
    '',
    LOC_BLOCK_END
  ].join('\n')
}

export function mergeLocBlock(body, totals) {
  const block = renderLocBlock(totals)
  const current = body ?? ''
  const start = current.indexOf(LOC_BLOCK_START)
  const end = current.indexOf(LOC_BLOCK_END)

  if (start !== -1 && end !== -1 && end > start) {
    const rest = current.slice(end + LOC_BLOCK_END.length).replace(/^\r?\n/, '')
    if (rest.trim().length === 0) {
      return `${current.slice(0, start)}${block}\n`
    }
    return `${current.slice(0, start)}${block}\n\n${rest.replace(/^\r?\n+/, '')}`
  }

  if (current.trim().length === 0) {
    return `${block}\n`
  }

  return `${block}\n\n${current.replace(/^\r?\n+/, '')}`
}
