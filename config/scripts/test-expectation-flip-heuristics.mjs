// The four diff shapes that mean an EXISTING test stopped asserting what it used to, in
// the two areas where a silently-rewritten expectation shipped a user-visible break
// (#19542/#19684): the Playwright suite that does not gate PRs, and the orchestration RPC
// methods. A renamed title, a success path turned into an error expectation, a populated
// expectation emptied, and an enabled test turned into .skip/.fixme.
//
// Deliberately hunk-scoped and textual. Known false negatives: a test deleted in one hunk
// and re-added in another reads as an unrelated delete plus add, and a test DELETED
// outright has no addition to pair with, so neither is flagged. Renames are
// direction-blind, so restoring an old title is flagged too. Each costs one PR-body
// paragraph, which is the whole price of the gate.
//
// The CLI, the escape hatch and the exit codes live in check-flipped-test-assertions.mjs.

export const SCOPED_DIRECTORIES = ['tests/e2e/', 'src/main/runtime/rpc/methods/orchestration/']
const TEST_FILE_PATTERN = /\.(?:spec\.ts|test\.ts|test\.mjs)$/
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const TEST_TITLE_PATTERN = /\b(?:test|it|describe)((?:\.[\w$]+)*)\s*\(\s*(['"`])([^'"`]*)\2/
// `.only` is not a disable: it narrows a run, it does not stop asserting.
const DISABLING_MODIFIER = /^(?:skip|fixme)$/
const DISABLED_CALL = /\.(?:skip|fixme)\s*\(/
// `toBeInstanceOf(Error)` and `toBeInstanceOf(RuntimeRpcFailureError)` both count.
const FAILURE_EXPECTATION = /toThrow|\.rejects\b|toBeInstanceOf\(\s*\w*Error\b/
// The removed side of a flip: the line that consumed a successful result.
const SUCCESS_PATH = /expect\(|await\s/
const EMPTY_EXPECTATION =
  /\.toEqual\(\s*[[{]\s*[\]}]\s*\)|\.toHaveLength\(\s*0\s*\)|\.toBeNull\(\s*\)|\.toBeUndefined\(\s*\)/
const NON_EMPTY_EXPECTATION =
  /toMatchObject|toContain|\.toHaveLength\(\s*[1-9]|\.toEqual\(\s*[[{](?!\s*[\]}]\s*\))/

export function isScopedTestFile(file) {
  return (
    SCOPED_DIRECTORIES.some((prefix) => file.startsWith(prefix)) && TEST_FILE_PATTERN.test(file)
  )
}

export function parseUnifiedDiffHunks(diff) {
  const hunks = []
  let file = null
  let hunk = null
  let newLine = 0
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim()
      file = target === '/dev/null' ? null : target.replace(/^b\//, '')
      hunk = null
      continue
    }
    if (raw.startsWith('--- ')) {
      continue
    }
    const header = HUNK_HEADER_PATTERN.exec(raw)
    if (header) {
      newLine = Number.parseInt(header[1], 10)
      hunk = file === null ? null : { file, added: [], removed: [] }
      if (hunk !== null) {
        hunks.push(hunk)
      }
      continue
    }
    if (hunk === null) {
      continue
    }
    if (raw.startsWith('+')) {
      hunk.added.push({ line: newLine, text: raw.slice(1) })
      newLine += 1
    } else if (raw.startsWith('-')) {
      hunk.removed.push({ line: newLine, text: raw.slice(1) })
    } else if (!raw.startsWith('\\')) {
      newLine += 1
    }
  }
  return hunks
}

function codeLines(lines) {
  return lines.filter(({ text }) => !/^\s*(?:\/\/|\/\*|\*)/.test(text))
}

export function extractTestTitles(lines) {
  const titles = []
  for (const { line, text } of codeLines(lines)) {
    const match = TEST_TITLE_PATTERN.exec(text)
    if (match) {
      const modifiers = match[1].split('.').filter(Boolean)
      titles.push({
        line,
        title: match[3],
        text,
        disabled: modifiers.some((modifier) => DISABLING_MODIFIER.test(modifier))
      })
    }
  }
  return titles
}

export function findRenamedTests(hunk) {
  const removed = extractTestTitles(hunk.removed)
  const added = extractTestTitles(hunk.added)
  const removedTitles = new Set(removed.map((entry) => entry.title))
  const addedTitles = new Set(added.map((entry) => entry.title))
  const dropped = removed.filter((entry) => !addedTitles.has(entry.title))
  const introduced = added.filter((entry) => !removedTitles.has(entry.title))
  return dropped.slice(0, introduced.length).map((entry, index) => ({
    file: hunk.file,
    line: introduced[index].line,
    kind: 'renamed test',
    removed: entry.title,
    added: introduced[index].title
  }))
}

// A test turned off still reads as a passing suite, which is how a known-broken
// expectation survives review. Unskipping is not flagged; a new skipped test is not
// either, because there is no earlier expectation it stops enforcing.
export function findDisabledTests(hunk) {
  const enabledByTitle = new Map(
    extractTestTitles(hunk.removed)
      .filter((entry) => !entry.disabled)
      .map((entry) => [entry.title, entry])
  )
  // Fallback for a title that sits on its own line: any removed line that is not itself
  // a skip and still mentions the title counts as the enabled predecessor.
  const enabledLines = codeLines(hunk.removed).filter(({ text }) => !DISABLED_CALL.test(text))
  const findings = []
  for (const entry of extractTestTitles(hunk.added)) {
    if (!entry.disabled) {
      continue
    }
    const predecessor =
      enabledByTitle.get(entry.title) ??
      enabledLines.find(({ text }) => entry.title !== '' && text.includes(entry.title))
    if (predecessor) {
      findings.push({
        file: hunk.file,
        line: entry.line,
        kind: 'test disabled',
        removed: predecessor.text.trim(),
        added: entry.text.trim()
      })
    }
  }
  return findings
}

export function findFlippedToFailure(hunk) {
  const removed = codeLines(hunk.removed).find(
    ({ text }) => SUCCESS_PATH.test(text) && !FAILURE_EXPECTATION.test(text)
  )
  const added = codeLines(hunk.added).find(({ text }) => FAILURE_EXPECTATION.test(text))
  if (!removed || !added) {
    return []
  }
  return [
    {
      file: hunk.file,
      line: added.line,
      kind: 'flipped to expect-failure',
      removed: removed.text.trim(),
      added: added.text.trim()
    }
  ]
}

export function findEmptiedExpectations(hunk) {
  const removed = codeLines(hunk.removed).find(({ text }) => NON_EMPTY_EXPECTATION.test(text))
  const added = codeLines(hunk.added).find(({ text }) => EMPTY_EXPECTATION.test(text))
  if (!removed || !added) {
    return []
  }
  return [
    {
      file: hunk.file,
      line: added.line,
      kind: 'expectation emptied',
      removed: removed.text.trim(),
      added: added.text.trim()
    }
  ]
}

export function collectFindings(diff) {
  return parseUnifiedDiffHunks(diff)
    .filter((hunk) => isScopedTestFile(hunk.file))
    .flatMap((hunk) => [
      ...findRenamedTests(hunk),
      ...findDisabledTests(hunk),
      ...findFlippedToFailure(hunk),
      ...findEmptiedExpectations(hunk)
    ])
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line}: ${finding.kind}: ${finding.removed} → ${finding.added}`
}
