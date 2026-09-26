import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { hasUserVisibleChangeSection, main } from './check-flipped-test-assertions.mjs'
import {
  collectFindings,
  extractTestTitles,
  findDisabledTests,
  findEmptiedExpectations,
  findFlippedToFailure,
  findRenamedTests,
  isScopedTestFile,
  parseUnifiedDiffHunks
} from './test-expectation-flip-heuristics.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parseYaml(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
const packageScripts = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).scripts

// Verbatim `git diff 750e6ffada^ 750e6ffada --unified=0` (#19684, the test-only PR that rewrote
// the spec which had already caught #19542 on main). Frozen as text rather than read from git so
// the gate stays proven against the real regression in a shallow clone.
const PR_19684_DIFF = `diff --git a/tests/e2e/orchestration-idle-mail-delivery.spec.ts b/tests/e2e/orchestration-idle-mail-delivery.spec.ts
index f679bdba60..8ca6657ab7 100644
--- a/tests/e2e/orchestration-idle-mail-delivery.spec.ts
+++ b/tests/e2e/orchestration-idle-mail-delivery.spec.ts
@@ -37,0 +38 @@ import { RuntimeClient, type RuntimeRpcSuccess } from '../../src/cli/runtime-cli
+import { RuntimeRpcFailureError } from '../../src/cli/runtime/types'
@@ -353 +354,4 @@ test.describe('orchestration push-on-idle mail delivery', () => {
-  test('keeps unbound direct mail durable without pointing to an unsafe check', async ({
+  // #19542 deleted the legacy-Run write fallback, so a sender in no Run has
+  // nowhere to file mail to a bare handle: the send is refused outright, which
+  // is what keeps an unsafe pointer out of the pane on the next idle frame.
+  test('refuses unbound direct mail from a sender in no Run instead of pushing it', async ({
@@ -363 +367,25 @@ test.describe('orchestration push-on-idle mail delivery', () => {
-    const messageId = await sendMail(client, pane.handle, { subject: 'Unbound direct mail' })
+    const refusal = await sendMail(client, pane.handle, { subject: 'Unbound direct mail' }).then(
+      () => undefined,
+      (error: unknown) => error
+    )
+    // Why runtime_error and not run_required: insertMessage throws a plain
+    // Error, which the dispatcher passes through with its message and no
+    // recovery data — the sibling no-recipient path is the one that adds it.
+    // The request-id suffix and stamp are the client's durable-mutation bookkeeping.
+    expect(refusal).toBeInstanceOf(RuntimeRpcFailureError)
+    expect(refusal).toMatchObject({
+      code: 'runtime_error',
+      message: expect.stringContaining('Run is required')
+    })
+    // Pins that the SERVER attached no orchestrationSkillRecoveryData, without
+    // freezing whatever else the client may stamp alongside its request id.
+    const refusalData = (refusal as RuntimeRpcFailureError).data
+    expect(refusalData).toMatchObject({ orchestrationRequestId: expect.any(String) })
+    expect(refusalData).not.toHaveProperty('effectsApplied')
+    expect(refusalData).not.toHaveProperty('guide')
+    expect(refusalData).not.toHaveProperty('nextCommandArgs')
+    expect(refusalData).not.toHaveProperty('nextSteps')
+    expect(readMailbox(userDataDir, pane.handle)).toEqual([])
+
+    // A busy→idle edge is the push trigger. Walking one proves the refusal left
+    // nothing behind for the scan to point at, not merely that the push was slow.
@@ -369,5 +397,3 @@ test.describe('orchestration push-on-idle mail delivery', () => {
-    expect(readMailRow(userDataDir, messageId)).toMatchObject({
-      to_handle: pane.handle,
-      read: 0,
-      delivered_at: null
-    })
+    // The ledger only proves anything once the push window has fully elapsed.
+    await orcaPage.waitForTimeout(NO_DELIVERY_SETTLE_MS)
+    expect(readMailbox(userDataDir, pane.handle)).toEqual([])
`

// #19684's real section set, abridged. What matters is that none of its headings is the
// escape hatch, which is why the gate would have held it.
const PR_19684_BODY = [
  '## ELI5',
  '',
  'One E2E test still expected the pre-#19542 world where mail to a bare terminal handle',
  'from a sender in no Run was quietly filed under the legacy Run.',
  '',
  '## What Changed',
  '',
  '- `tests/e2e/orchestration-idle-mail-delivery.spec.ts`: the test is rewritten to pin the refusal.',
  '- No product code changed. Neighbouring tests untouched.',
  '',
  '## Why',
  '',
  '#19542 deleted every `?? LEGACY_RUN_ID` write fallback, so `insertMessage` now throws.',
  '',
  '## Testing',
  '',
  '| Command | Result |',
  '| --- | --- |',
  '| the spec, `-g "unbound direct mail"` | 1 passed |'
].join('\n')

function diffOf(file, header, lines) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    header,
    ...lines
  ].join('\n')
}

describe('gate scope', () => {
  it.each([
    'tests/e2e/orchestration-idle-mail-delivery.spec.ts',
    'tests/e2e/cross-version-wire/terminal-stream.spec.ts',
    'src/main/runtime/rpc/methods/orchestration/send-unbound-terminals.test.ts'
  ])('gates %s', (file) => {
    expect(isScopedTestFile(file)).toBe(true)
  })

  it.each([
    'tests/e2e/fixtures/orchestration-fake-agent.ts',
    'src/main/runtime/rpc/methods/orchestration/send-methods.ts',
    'src/main/runtime/orchestration/db/messages/message-insert.test.ts',
    'src/cli/handlers/orchestration.test.ts'
  ])('does not gate %s', (file) => {
    expect(isScopedTestFile(file)).toBe(false)
  })
})

describe('unified diff parsing', () => {
  it('keeps the file header out of the hunk and numbers added lines on the new side', () => {
    const hunks = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -10,2 +12,3 @@', [
        '-const before = 1',
        '-const gone = 2',
        '+const after = 1',
        ' context',
        '+const tail = 3'
      ])
    )

    expect(hunks).toEqual([
      {
        file: 'tests/e2e/a.spec.ts',
        removed: [
          { line: 12, text: 'const before = 1' },
          { line: 12, text: 'const gone = 2' }
        ],
        added: [
          { line: 12, text: 'const after = 1' },
          { line: 14, text: 'const tail = 3' }
        ]
      }
    ])
  })

  it('reads a deleted file as no hunks so its removals cannot pair with another file', () => {
    const diff = [
      'diff --git a/tests/e2e/a.spec.ts b/tests/e2e/a.spec.ts',
      '--- a/tests/e2e/a.spec.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      "-test('kept', () => {})",
      '-expect(rows).toMatchObject({ read: 0 })'
    ].join('\n')

    expect(parseUnifiedDiffHunks(diff)).toEqual([])
  })
})

describe('renamed test heuristic', () => {
  it('flags a title replaced in the same hunk', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3 +3 @@', [
        "-  test('keeps unbound direct mail durable', async () => {",
        "+  test('refuses unbound direct mail', async () => {"
      ])
    )

    expect(findRenamedTests(hunk)).toEqual([
      {
        file: 'tests/e2e/a.spec.ts',
        line: 3,
        kind: 'renamed test',
        removed: 'keeps unbound direct mail durable',
        added: 'refuses unbound direct mail'
      }
    ])
  })

  it('ignores an edit that keeps the title', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3 +3 @@', [
        "-  test('keeps unbound direct mail durable', async () => {",
        "+  test('keeps unbound direct mail durable', async ({ page }) => {"
      ])
    )

    expect(findRenamedTests(hunk)).toEqual([])
  })

  it('ignores a brand new test with nothing removed', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3,0 +4 @@', ["+  test('a new case', async () => {})"])
    )

    expect(findRenamedTests(hunk)).toEqual([])
  })

  it('ignores a title quoted inside a comment', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3 +3 @@', [
        "-  // superseded by test('old name', ...)",
        "+  // superseded by test('new name', ...)"
      ])
    )

    expect(findRenamedTests(hunk)).toEqual([])
  })

  // Direction-blind on purpose: nothing in a diff says which title carries the older intent,
  // so restoring a renamed test is flagged too. The cost is the same one paragraph.
  it('flags the restoring direction as well', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3 +3 @@', [
        "-  test('refuses unbound direct mail', async () => {",
        "+  test('keeps unbound direct mail durable', async () => {"
      ])
    )

    expect(findRenamedTests(hunk)).toHaveLength(1)
  })

  it('reads it(), describe() and test.describe() titles, and marks the disabled ones', () => {
    expect(
      extractTestTitles([
        { line: 1, text: "  it('does a thing', () => {" },
        { line: 2, text: "  test.describe('a suite', () => {" },
        { line: 3, text: "  test.skip('skipped', () => {" },
        { line: 4, text: "  describe.skip('a skipped suite', () => {" },
        { line: 5, text: "  it.only('focused', () => {" },
        { line: 6, text: '  const unrelated = 1' }
      ])
    ).toEqual([
      { line: 1, title: 'does a thing', text: "  it('does a thing', () => {", disabled: false },
      { line: 2, title: 'a suite', text: "  test.describe('a suite', () => {", disabled: false },
      { line: 3, title: 'skipped', text: "  test.skip('skipped', () => {", disabled: true },
      {
        line: 4,
        title: 'a skipped suite',
        text: "  describe.skip('a skipped suite', () => {",
        disabled: true
      },
      // `.only` narrows a run; it does not stop asserting, so it is not a disable.
      { line: 5, title: 'focused', text: "  it.only('focused', () => {", disabled: false }
    ])
  })
})

describe('disabled-test heuristic', () => {
  it.each([
    ["+  test.skip('keeps unbound direct mail durable', async () => {", 'test.skip'],
    ["+  test.fixme('keeps unbound direct mail durable', async () => {", 'test.fixme'],
    ["+  it.skip('keeps unbound direct mail durable', async () => {", 'it.skip']
  ])('flags an existing test turned into %s', (added) => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3 +3 @@', [
        "-  test('keeps unbound direct mail durable', async () => {",
        added
      ])
    )

    expect(findDisabledTests(hunk)).toEqual([
      {
        file: 'tests/e2e/a.spec.ts',
        line: 3,
        kind: 'test disabled',
        removed: "test('keeps unbound direct mail durable', async () => {",
        added: added.slice(1).trim()
      }
    ])
  })

  it('flags a describe turned into describe.skip', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('src/main/runtime/rpc/methods/orchestration/send.test.ts', '@@ -3 +3 @@', [
        "-describe('unbound send', () => {",
        "+describe.skip('unbound send', () => {"
      ])
    )

    expect(findDisabledTests(hunk)).toHaveLength(1)
  })

  // The title can sit on its own line when the call is wrapped, so the removed side is
  // matched on text as well as on an extracted title.
  it('flags a skip whose predecessor line only mentions the title', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3,2 +3 @@', [
        '-  test(',
        "-    'keeps unbound direct mail durable',",
        "+  test.skip('keeps unbound direct mail durable', async () => {"
      ])
    )

    expect(findDisabledTests(hunk)).toHaveLength(1)
  })

  // Re-enabling a test is the direction that adds coverage back.
  it('does not flag unskipping', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3 +3 @@', [
        "-  test.skip('keeps unbound direct mail durable', async () => {",
        "+  test('keeps unbound direct mail durable', async () => {"
      ])
    )

    expect(findDisabledTests(hunk)).toEqual([])
  })

  it('does not flag a brand new skipped test', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3,0 +4 @@', [
        "+  test.skip('a case nobody has written yet', async () => {})"
      ])
    )

    expect(findDisabledTests(hunk)).toEqual([])
  })

  it('does not flag dropping .only, which re-widens the run', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3 +3 @@', [
        "-  test.only('keeps unbound direct mail durable', async () => {",
        "+  test('keeps unbound direct mail durable', async () => {"
      ])
    )

    expect(findDisabledTests(hunk)).toEqual([])
  })

  it('does not double-report a skip as a rename', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -3 +3 @@', [
        "-  test('keeps unbound direct mail durable', async () => {",
        "+  test.skip('keeps unbound direct mail durable', async () => {"
      ])
    )

    expect(findRenamedTests(hunk)).toEqual([])
  })
})

describe('flipped-to-expect-failure heuristic', () => {
  it('flags a consumed result replaced by an error expectation', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -8 +8,2 @@', [
        '-    const messageId = await sendMail(client, pane.handle)',
        '+    const refusal = await sendMail(client, pane.handle).catch((error) => error)',
        '+    expect(refusal).toBeInstanceOf(RuntimeRpcFailureError)'
      ])
    )

    expect(findFlippedToFailure(hunk)).toEqual([
      {
        file: 'tests/e2e/a.spec.ts',
        line: 9,
        kind: 'flipped to expect-failure',
        removed: 'const messageId = await sendMail(client, pane.handle)',
        added: 'expect(refusal).toBeInstanceOf(RuntimeRpcFailureError)'
      }
    ])
  })

  it.each([
    '+    await expect(send()).rejects.toThrow()',
    '+    expect(send).toThrow()',
    '+    expect(refusal).toBeInstanceOf(Error)'
  ])('flags %s', (added) => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -8 +8 @@', ['-    expect(await send()).toBe(1)', added])
    )

    expect(findFlippedToFailure(hunk)).toHaveLength(1)
  })

  // A fix that restores working behaviour must not pay the gate's price.
  it('does not flag the reverse direction', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -8,2 +8,2 @@', [
        '-    await expect(sendMail(client, pane.handle)).rejects.toThrow()',
        '-    expect(refusal).toBeInstanceOf(RuntimeRpcFailureError)',
        '+    const messageId = await sendMail(client, pane.handle)',
        '+    expect(readMailRow(dir, messageId)).toMatchObject({ read: 0 })'
      ])
    )

    expect(findFlippedToFailure(hunk)).toEqual([])
  })

  it('does not flag a hunk that only adds an error expectation', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -8,0 +9 @@', [
        '+    await expect(sendMail(client, other)).rejects.toThrow()'
      ])
    )

    expect(findFlippedToFailure(hunk)).toEqual([])
  })
})

describe('emptied-expectation heuristic', () => {
  it.each([
    '+    expect(readMailbox(dir, handle)).toEqual([])',
    '+    expect(readMailbox(dir, handle)).toHaveLength(0)',
    '+    expect(readMailRow(dir, id)).toBeNull()',
    '+    expect(readMailRow(dir, id)).toBeUndefined()',
    '+    expect(snapshot).toEqual({})'
  ])('flags %s replacing a populated expectation', (added) => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -8,2 +8 @@', [
        '-    expect(readMailRow(dir, messageId)).toMatchObject({',
        '-      read: 0',
        added
      ])
    )

    expect(findEmptiedExpectations(hunk)).toHaveLength(1)
  })

  it.each([
    '-    expect(rows).toEqual([{ id: 1 }])',
    '-    expect(rows).toContain(handle)',
    '-    expect(rows).toHaveLength(2)'
  ])('accepts %s as the populated side', (removed) => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -8 +8 @@', [removed, '+    expect(rows).toEqual([])'])
    )

    expect(findEmptiedExpectations(hunk)).toHaveLength(1)
  })

  it('does not flag the reverse direction', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -8 +8 @@', [
        '-    expect(readMailbox(dir, handle)).toEqual([])',
        '+    expect(readMailRow(dir, messageId)).toMatchObject({ read: 0 })'
      ])
    )

    expect(findEmptiedExpectations(hunk)).toEqual([])
  })

  it('does not flag an emptiness assertion added beside an unrelated removal', () => {
    const [hunk] = parseUnifiedDiffHunks(
      diffOf('tests/e2e/a.spec.ts', '@@ -8 +8,2 @@', [
        '-    const dir = makeUserDataDir()',
        '+    const dir = makeUserDataDir({ seeded: false })',
        '+    expect(readMailbox(dir, handle)).toEqual([])'
      ])
    )

    expect(findEmptiedExpectations(hunk)).toEqual([])
  })
})

describe('the #19684 diff', () => {
  it('reports all three flips with their file and line', () => {
    expect(collectFindings(PR_19684_DIFF)).toEqual([
      {
        file: 'tests/e2e/orchestration-idle-mail-delivery.spec.ts',
        line: 357,
        kind: 'renamed test',
        removed: 'keeps unbound direct mail durable without pointing to an unsafe check',
        added: 'refuses unbound direct mail from a sender in no Run instead of pushing it'
      },
      {
        file: 'tests/e2e/orchestration-idle-mail-delivery.spec.ts',
        line: 375,
        kind: 'flipped to expect-failure',
        removed:
          "const messageId = await sendMail(client, pane.handle, { subject: 'Unbound direct mail' })",
        added: 'expect(refusal).toBeInstanceOf(RuntimeRpcFailureError)'
      },
      {
        file: 'tests/e2e/orchestration-idle-mail-delivery.spec.ts',
        line: 399,
        kind: 'expectation emptied',
        removed: 'expect(readMailRow(userDataDir, messageId)).toMatchObject({',
        added: 'expect(readMailbox(userDataDir, pane.handle)).toEqual([])'
      }
    ])
  })

  it('ignores the same flips outside the gated paths', () => {
    const moved = PR_19684_DIFF.replaceAll(
      'tests/e2e/orchestration-idle-mail-delivery.spec.ts',
      'src/main/runtime/orchestration/idle-mail-delivery.test.ts'
    )

    expect(collectFindings(moved)).toEqual([])
  })
})

describe('the escape-hatch section', () => {
  it('accepts the section with both lines', () => {
    expect(
      hasUserVisibleChangeSection(
        ['## User-visible change', 'Before: mail was stored.', 'After: the send is refused.'].join(
          '\n'
        )
      )
    ).toBe(true)
  })

  it('accepts bulleted and bolded lines', () => {
    expect(
      hasUserVisibleChangeSection(
        ['## User-visible change', '- **Before:** stored', '- **After:** refused'].join('\n')
      )
    ).toBe(true)
  })

  it('rejects the #19684 body, whose headings never explain the outcome change', () => {
    expect(hasUserVisibleChangeSection(PR_19684_BODY)).toBe(false)
  })

  it('rejects an empty or absent body', () => {
    expect(hasUserVisibleChangeSection('')).toBe(false)
    expect(hasUserVisibleChangeSection(undefined)).toBe(false)
  })

  it.each([
    ['only Before', ['## User-visible change', 'Before: stored']],
    ['only After', ['## User-visible change', 'After: refused']],
    [
      'both lines after the section ended',
      ['## User-visible change', '## Testing', 'Before: stored', 'After: refused']
    ]
  ])('rejects a section with %s', (_label, lines) => {
    expect(hasUserVisibleChangeSection(lines.join('\n'))).toBe(false)
  })

  // Exact on purpose: a near-miss heading must fail loudly rather than silently excuse a flip.
  it.each(['## User-visible changes', '## User visible change', '## user-visible change'])(
    'does not accept %s',
    (heading) => {
      expect(
        hasUserVisibleChangeSection([heading, 'Before: stored', 'After: refused'].join('\n'))
      ).toBe(false)
    }
  )

  it('accepts a deeper heading level', () => {
    expect(
      hasUserVisibleChangeSection(
        ['### User-visible change', 'Before: stored', 'After: refused'].join('\n')
      )
    ).toBe(true)
  })
})

describe('exit codes', () => {
  let diffFile

  beforeEach(() => {
    diffFile = join(mkdtempSync(join(tmpdir(), 'flipped-assertion-')), '19684.diff')
    writeFileSync(diffFile, PR_19684_DIFF)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fails when CI requires a body that does not explain the flips', () => {
    expect(
      main(['--diff-file', diffFile, '--require-body'], projectDir, { PR_BODY: PR_19684_BODY })
    ).toBe(1)
  })

  it('passes once the body carries the section', () => {
    const body = `${PR_19684_BODY}\n\n## User-visible change\n\nBefore: stored\nAfter: refused\n`

    expect(main(['--diff-file', diffFile, '--require-body'], projectDir, { PR_BODY: body })).toBe(0)
  })

  it('reports without failing when the body is not available', () => {
    expect(main([`--diff-file=${diffFile}`], projectDir, {})).toBe(0)
  })

  it('passes a diff with no gated flip', () => {
    writeFileSync(
      diffFile,
      diffOf('tests/e2e/a.spec.ts', '@@ -8,0 +9 @@', ['+    expect(rows).toHaveLength(2)'])
    )

    expect(main(['--diff-file', diffFile, '--require-body'], projectDir, {})).toBe(0)
  })
})

describe('CI wiring', () => {
  const step = prWorkflow.jobs.static_analysis.steps.find(
    (candidate) => candidate.name === 'Check flipped test assertions'
  )

  // static_analysis is the job to extend: it is already in verify.needs, already runs for every
  // non-docs PR, and already checks out full history for the sibling changed-code gate's diff.
  it('runs in a job verify blocks on', () => {
    expect(step).toBeDefined()
    expect(prWorkflow.jobs.verify.needs).toContain('static_analysis')
  })

  it('requires the body and passes the PR base SHA', () => {
    expect(step.run).toContain('pnpm run check:flipped-test-assertions')
    expect(step.run).toContain('--require-body')
    expect(step.run).toContain('"$BASE_SHA"')
  })

  // Why env and not interpolation: a PR body is attacker-controlled text, and `${{ }}` inside a
  // run: block is substituted before the shell parses it.
  it('reads the body through env, never interpolated into the shell', () => {
    expect(step.env.PR_BODY).toBe('${{ github.event.pull_request.body }}')
    expect(step.env.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}')
    expect(step.run).not.toContain('github.event.pull_request.body')
  })

  it('is a real package script', () => {
    expect(packageScripts['check:flipped-test-assertions']).toBe(
      'node config/scripts/check-flipped-test-assertions.mjs'
    )
  })
})
