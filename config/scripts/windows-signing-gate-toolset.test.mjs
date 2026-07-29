import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: the inner-binary signing gate silently degraded for four releases because it
// shelled out to a hardcoded `node_modules/7zip-bin/...` path that electron-builder
// 26.9+ no longer installs. Pin both workflows to the resolver instead (#6487).

const workflowsDir = resolve(import.meta.dirname, '../..', '.github', 'workflows')

const GATED_WORKFLOWS = ['release-cut.yml', 'windows-signing-rehearsal.yml']

function workflowSource(name) {
  return readFileSync(join(workflowsDir, name), 'utf8')
}

// Why a scanner and not a regex: PowerShell gates here contain braces inside
// strings (`"{0,-14} {1}  <{2}>" -f ...`) and inside comments, so naive brace
// counting mis-pairs and every scope assertion below silently degrades into
// "some text appears somewhere in the file". The same walk also lets assertions
// distinguish a keyword the shell executes from the same word sitting in a
// message string — downgrading `throw` to `Write-Host "...would throw..."`
// otherwise passes a `/\bthrow\b/` check while restoring the silent fail-open.

/** `source` split into `{start, end, kind}` spans, kind being 'code' | 'string' | 'comment'. */
function scanSpans(source) {
  // Here-strings use different terminator rules; refusing them beats mis-pairing silently.
  expect(source, 'here-strings are not understood by this scanner').not.toMatch(/@['"]/)
  const spans = []
  let i = 0
  while (i < source.length) {
    const char = source[i]
    if (char === '#') {
      const newline = source.indexOf('\n', i)
      const end = newline === -1 ? source.length : newline
      spans.push({ start: i, end, kind: 'comment' })
      i = end
      continue
    }
    if (char === "'") {
      let end = i + 1
      while (end < source.length) {
        if (source[end] !== "'") {
          end += 1
        } else if (source[end + 1] === "'") {
          end += 2 // doubled '' escapes a quote rather than closing the string
        } else {
          break
        }
      }
      end = Math.min(end + 1, source.length)
      spans.push({ start: i, end, kind: 'string' })
      i = end
      continue
    }
    if (char === '"') {
      let end = i + 1
      while (end < source.length && source[end] !== '"') {
        end += source[end] === '`' ? 2 : 1
      }
      end = Math.min(end + 1, source.length)
      spans.push({ start: i, end, kind: 'string' })
      i = end
      continue
    }
    let end = i
    while (end < source.length && !'#\'"'.includes(source[end])) {
      end += 1
    }
    spans.push({ start: i, end, kind: 'code' })
    i = end
  }
  return spans
}

/** `source` with the named span kinds blanked to spaces — same length, so indices still line up. */
function blank(source, spans, kinds) {
  const chars = source.split('')
  for (const span of spans) {
    if (!kinds.includes(span.kind)) {
      continue
    }
    for (let i = span.start; i < span.end; i += 1) {
      if (chars[i] !== '\n') {
        chars[i] = ' '
      }
    }
  }
  return chars.join('')
}

/** `source` with comments blanked — for assertions whose subject is a literal the gate prints. */
function withoutComments(source) {
  return blank(source, scanSpans(source), ['comment'])
}

/** `source` with strings and comments blanked — for assertions about executed statements. */
function codeOf(source) {
  return blank(source, scanSpans(source), ['string', 'comment'])
}

/**
 * The `{ ... }` block opening after `marker`. `code` has strings and comments blanked, so a
 * keyword assertion against it can only be satisfied by a keyword the shell would execute;
 * `text` keeps strings but drops comments, for assertions about literals the gate emits.
 */
function blockAfter(source, marker, from = 0) {
  const spans = scanSpans(source)
  const code = blank(source, spans, ['string', 'comment'])
  const markerIndex = code.indexOf(marker, from)
  expect(markerIndex, `missing marker: ${marker}`).toBeGreaterThan(-1)
  const start = code.indexOf('{', markerIndex)
  expect(start, `no block opens after: ${marker}`).toBeGreaterThan(-1)
  let depth = 0
  let end = -1
  for (let i = start; i < source.length && end === -1; i += 1) {
    if (code[i] === '{') {
      depth += 1
    } else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
      }
    }
  }
  expect(end, `unbalanced block after: ${marker}`).toBeGreaterThan(-1)
  return {
    start,
    end,
    code: code.slice(start, end + 1),
    text: blank(source, spans, ['comment']).slice(start, end + 1)
  }
}

/**
 * The innermost `{ ... }` block enclosing `marker`, plus the keyword introducing it.
 * Needed where the anchor is the block's *contents*: `blockAfter(step, '} catch {')` picks
 * whichever catch comes first in the file, which stopped being the gate's own once the
 * persistence helpers grew their own try/catch.
 */
function blockEnclosing(source, marker) {
  const spans = scanSpans(source)
  const code = blank(source, spans, ['string', 'comment'])
  // Located in the comment-stripped text (the marker may include a string literal),
  // then paired in `code`; both blankings preserve length, so indices line up.
  const markerIndex = blank(source, spans, ['comment']).indexOf(marker)
  expect(markerIndex, `missing marker: ${marker}`).toBeGreaterThan(-1)
  let depth = 0
  let end = -1
  for (let i = markerIndex; i < code.length && end === -1; i += 1) {
    if (code[i] === '{') {
      depth += 1
    } else if (code[i] === '}') {
      if (depth === 0) {
        end = i
      } else {
        depth -= 1
      }
    }
  }
  depth = 0
  let start = -1
  for (let i = markerIndex; i >= 0 && start === -1; i -= 1) {
    if (code[i] === '}') {
      depth += 1
    } else if (code[i] === '{') {
      if (depth === 0) {
        start = i
      } else {
        depth -= 1
      }
    }
  }
  expect(start, `no block encloses: ${marker}`).toBeGreaterThan(-1)
  expect(end, `no block encloses: ${marker}`).toBeGreaterThan(-1)
  return { start, end, keyword: code.slice(0, start).trimEnd().split(/\s+/).pop() }
}

describe('Windows signing gates resolve 7za through the toolset resolver (#6487)', () => {
  for (const name of GATED_WORKFLOWS) {
    it(`${name} does not hardcode the removed 7zip-bin path`, () => {
      expect(workflowSource(name)).not.toContain('node_modules/7zip-bin')
    })

    it(`${name} resolves 7za via resolve-7za-path.mjs`, () => {
      expect(workflowSource(name)).toContain('node config/scripts/resolve-7za-path.mjs')
    })

    it(`${name} checks resolver failure before trimming its output`, () => {
      const source = workflowSource(name)
      const code = codeOf(source)
      const resolveIndex = code.indexOf('$7zaOutput = node config/scripts/resolve-7za-path.mjs')
      const exitCodeIndex = code.indexOf('$7zaExitCode = $LASTEXITCODE')
      const exitGuard = blockAfter(source, 'if ($7zaExitCode -ne 0)')
      const trimIndex = code.indexOf('$7za = ($7zaOutput | Out-String).Trim()')

      expect(resolveIndex).toBeGreaterThan(-1)
      expect(exitCodeIndex).toBeGreaterThan(resolveIndex)
      expect(exitGuard.start).toBeGreaterThan(exitCodeIndex)
      expect(exitGuard.code).toMatch(/\bthrow\b/)
      expect(trimIndex).toBeGreaterThan(exitGuard.end)
    })

    it(`${name} rejects an empty or non-file 7za path`, () => {
      const source = workflowSource(name)
      const guard = blockAfter(
        source,
        'if ([string]::IsNullOrWhiteSpace($7za) -or -not (Test-Path -LiteralPath $7za -PathType Leaf))'
      )
      expect(guard.code).toMatch(/\bthrow\b/)
    })
  }

  // Why sliced to one step: release-cut.yml runs several PowerShell gates that
  // share idioms (`$failures`, `} catch {`), so a whole-file search silently
  // asserts against the wrong block.
  function innerBinaryStep() {
    const source = workflowSource('release-cut.yml')
    const start = source.indexOf('- name: Verify Windows inner binary signatures')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n      - name:', start + 1)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  // Why parse the function body rather than grep the file: asserting that the
  // string 'Write-GateVerdict' appears somewhere passes even if the body is
  // gutted to a Write-Host, which is exactly the silent degradation this gate
  // exists to prevent.
  function gateVerdictBlock() {
    return blockAfter(innerBinaryStep(), 'function Write-GateVerdict')
  }

  it('persists the verdict to the evidence file the artifact upload collects', () => {
    const block = gateVerdictBlock()
    expect(block.text).toMatch(/Set-Content\s+-Path\s+'inner-signing-evidence\.txt'/)
    expect(block.code).toContain('Add-GateSummary')
  })

  // Why cross-checked: the upload is `if-no-files-found: ignore`, so renaming the
  // evidence file on one side and not the other ships a green run with an artifact
  // that silently omits the verdict — the same class as the bug this PR fixes.
  it('uploads the exact evidence filename the gate writes', () => {
    const source = workflowSource('release-cut.yml')
    const uploadStart = source.indexOf('- name: Upload Windows inner signing evidence')
    expect(uploadStart).toBeGreaterThan(-1)
    const uploadEnd = source.indexOf('\n      - name:', uploadStart + 1)
    expect(uploadEnd).toBeGreaterThan(uploadStart)
    const upload = source.slice(uploadStart, uploadEnd)

    const step = innerBinaryStep()
    const written = new Set(
      [...withoutComments(step).matchAll(/-Path\s+'([\w.-]+\.txt)'/g)].map((m) => m[1])
    )
    expect(written.size).toBeGreaterThan(0)
    for (const file of written) {
      expect(upload, `${file} is written by the gate but never uploaded`).toContain(file)
    }
  })

  it('never lets verdict persistence itself fail a warn-only release', () => {
    // Every persistence helper is best-effort: a disk-full or read-only runner
    // must not turn evidence-writing into the thing that fails the release.
    const step = innerBinaryStep()
    for (const helper of ['function Add-GateEvidence', 'function Add-GateSummary']) {
      const code = blockAfter(step, helper).code
      expect(code, helper).toContain('-ErrorAction Stop')
      expect(code, helper).toMatch(/\bcatch\b/)
    }
    expect(gateVerdictBlock().code).toMatch(/\bcatch\b/)
  })

  it('records a verdict on every terminal branch of the gate', () => {
    // Comments stripped: a `# VERDICT: PASSED` note must not stand in for the write.
    const step = withoutComments(innerBinaryStep())
    for (const verdict of ['NOT VERIFIED', 'ERRORED', 'VERDICT: FAILED', 'VERDICT: PASSED']) {
      expect(step).toContain(verdict)
    }
  })

  it('throws a required-mode signature failure outside the catch that would mask it', () => {
    // Why: throwing inside `try` re-enters the catch, whose Set-Content
    // replaces the per-file report with "ERRORED — <exception>".
    const step = innerBinaryStep()
    const policyThrow = codeOf(step).indexOf('if ($policyFailure) { throw $policyFailure }')
    expect(policyThrow).toBeGreaterThan(-1)
    // Anchored on the gate's own handler, not the first `catch` in the step: the
    // persistence helpers have their own, and they sit earlier in the file.
    const gateCatch = blockEnclosing(step, 'Write-GateVerdict "ERRORED')
    expect(gateCatch.keyword).toBe('catch')
    expect(policyThrow).toBeGreaterThan(gateCatch.end)
  })

  // Why: the assignment is what survives a write failure. With it after the
  // evidence/summary writes, a throwing Add-Content lands in the catch with
  // $policyFailure still null — required mode reports ERRORED and overwrites the
  // per-file report, reintroducing exactly the loss the hoist prevents.
  it('records the required-mode failure before attempting any evidence write', () => {
    const branch = blockAfter(innerBinaryStep(), 'if ($failures.Count -gt 0)').code
    const assignment = branch.indexOf('$policyFailure = $message')
    expect(assignment).toBeGreaterThan(-1)
    for (const write of ['Add-GateEvidence', 'Add-GateSummary']) {
      expect(branch.indexOf(write), write).toBeGreaterThan(assignment)
    }
  })
})
