/**
 * The proof that a native IME run was real.
 *
 * Playwright reports a skipped test as a pass, so every documented way this harness fails open —
 * an unset ORCA_E2E_NATIVE_IBUS_HANGUL, a renamed test the grep no longer selects, a stale
 * ibus-daemon that wins the XIM selection and leaves the session with no engine — produces a
 * green run that exercised nothing. The specs append a receipt only after they have observed
 * real composition events, and the runner requires one per expected test.
 */

export const IME_ENGAGEMENT_RECEIPT_ENV = 'ORCA_E2E_IME_ENGAGEMENT_RECEIPT'

/** The tests that must each leave a receipt. Pinned so deleting one cannot quietly shrink the lane. */
export const EXPECTED_NATIVE_IME_TESTS = [
  'forwards the issue exact-byte sequence without loss or duplication',
  'forwards the issue sentence stress sequence without leaked ASCII'
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

/**
 * Returns the reasons a run must not be trusted. An empty array means an input method
 * demonstrably composed text for every expected test.
 */
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
    // Why both: compositionstart alone fires for a bare keypress under some engines, and a
    // Hangul update alone would not prove the composition lifecycle ran.
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
