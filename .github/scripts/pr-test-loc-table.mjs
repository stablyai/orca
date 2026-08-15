export const LOC_BLOCK_START = '<!-- orca-pr-loc -->'
export const LOC_BLOCK_END = '<!-- /orca-pr-loc -->'
export const LOC_HANDS_OFF_COMMENT =
  '<!-- Programmatic LoC summary. Do not edit by hand; rewritten on every commit. -->'

const TEST_DIR_SEGMENT = /(?:^|\/)(?:__tests__|e2e|tests)(?:\/|$)/i
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

function signed(count) {
  if (count === 0) {
    return '0'
  }
  return count > 0 ? `+${count}` : `−${Math.abs(count)}`
}

function locTableRow(label, bucket) {
  return `| ${label} | ${bucket.files ?? 0} | ${signed(bucket.added)} | ${signed(-(bucket.deleted ?? 0))} | ${signed((bucket.added ?? 0) - (bucket.deleted ?? 0))} |`
}

export function formatLocTable({ test, nonTest }) {
  const total = {
    files: test.files + nonTest.files,
    added: test.added + nonTest.added,
    deleted: test.deleted + nonTest.deleted
  }
  return [
    '| | Files | Added | Deleted | Net |',
    '| :--- | ---: | ---: | ---: | ---: |',
    locTableRow('Test', test),
    locTableRow('Prod', nonTest),
    locTableRow('Total', total)
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
