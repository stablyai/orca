// Skipped/misselected Playwright tests and stale IBus can exit green without composing text; require a receipt from every pinned test after real composition.

export const IME_ENGAGEMENT_RECEIPT_ENV = 'ORCA_E2E_IME_ENGAGEMENT_RECEIPT'

/** The tests that must each leave a receipt. Pinned so deleting one cannot quietly shrink the lane. */
export const EXPECTED_NATIVE_IME_TESTS = [
  'forwards the issue exact-byte sequence without loss or duplication',
  'forwards the issue sentence stress sequence without leaked ASCII',
  'a digit typed right after a Hangul syllable reaches the pty',
  'confirms native Hangul notes before a deliberate Enter saves'
]

function parseReceipts(text) {
  const entries = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    try {
      entries.push(JSON.parse(line))
    } catch {
      entries.push({ malformed: line })
    }
  }
  return entries
}

// Empty failure list proves real input method composed in every expected test.
export function verifyImeEngagementReceipts(text, expectedTests = EXPECTED_NATIVE_IME_TESTS) {
  const entries = parseReceipts(text ?? '')
  const problems = []

  for (const entry of entries) {
    if (entry.malformed !== undefined) {
      problems.push(`malformed receipt line: ${entry.malformed}`)
    }
  }

  const seen = new Map()
  for (const entry of entries) {
    if (typeof entry.test === 'string') {
      seen.set(entry.test, entry)
    }
  }

  for (const test of expectedTests) {
    const entry = seen.get(test)
    if (!entry) {
      problems.push(
        `no engagement receipt for "${test}" — it was skipped, filtered out, or renamed`
      )
      continue
    }
    // Require start plus Hangul update: bare keypress can emit start alone, while update alone does not prove full lifecycle.
    if (!(entry.compositionStart > 0)) {
      problems.push(`"${test}" recorded no compositionstart — the IME never engaged`)
    }
    if (!(entry.hangulComposition > 0)) {
      problems.push(
        `"${test}" recorded no Hangul composition data — the engine produced no syllables`
      )
    }
  }

  const unexpected = [...seen.keys()].filter((test) => !expectedTests.includes(test))
  for (const test of unexpected) {
    problems.push(`unexpected engagement receipt for "${test}" — update EXPECTED_NATIVE_IME_TESTS`)
  }

  return problems
}
