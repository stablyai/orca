# Grok Orchestration Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` and execute this plan one checkbox at a time.

**Goal:** Make `orca orchestration send --to @grok ...` resolve Grok terminals with the same safe title-token behavior as the existing named agent groups.

**Architecture:** Extend the existing `AGENT_NAME_GROUPS` allowlist so the current generic resolver and `GroupAddress` type handle Grok without a provider-specific code path. Lock runtime and documentation behavior together with focused resolver and executable skill-guidance tests.

**Tech Stack:** TypeScript, Vitest, Markdown skill guidance, Node.js guidance tests, pnpm.

## Global Constraints

- Work only in this worktree and do not rebase or replace the existing design commit.
- Modify only the four implementation files named below plus this already-committed plan/design documentation.
- Follow red-green TDD: add assertions first, run them, and record the expected failure before changing production code or skill guidance.
- Reuse the generic title matcher. Do not add Grok-specific branching, platform checks, provider assumptions, or UI changes.
- Preserve standalone-token behavior for macOS, Linux, Windows, local, and SSH terminal titles.
- Do not add lint suppressions or vague new modules.

---

## Task 1: Add failing runtime and guidance coverage

**Files:**

- Modify: `src/main/runtime/orchestration/groups.test.ts`
- Modify: `config/scripts/orchestration-skill-guidance.test.mjs`
- Test: `src/main/runtime/orchestration/groups.test.ts`
- Test: `config/scripts/orchestration-skill-guidance.test.mjs`

- [ ] In `isGroupAddress`, add `expect(isGroupAddress('@grok')).toBe(true)` beside the other supported named groups.
- [ ] In the `agent name groups` block, add one focused test that proves case-insensitive group resolution, spinner-prefixed titles, sender exclusion, and false-positive rejection. Use this fixture shape:

```ts
it('matches @grok as a standalone title token and excludes sender', () => {
  const terminals = [
    makeSummary('term_a', { title: 'Grok' }),
    makeSummary('term_b', { title: 'GROK CLI' }),
    makeSummary('term_c', { title: '⠋ Grok' }),
    makeSummary('term_d', { title: 'ngrok' }),
    makeSummary('term_e', { title: '/tmp/grok' }),
    makeSummary('term_f', { title: 'my-grok-worker' }),
    makeSummary('term_g', { title: 'Codex CLI' })
  ]

  const result = resolveGroupAddress('@GrOk', 'term_a', terminals, noStatus)

  expect(result).toEqual(['term_b', 'term_c'])
})
```

- [ ] Add a guidance test that reads the `Messaging` section and requires the documented group list to contain `` `@grok` ``.
- [ ] Run the focused suites before implementation:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/runtime/orchestration/groups.test.ts \
  config/scripts/orchestration-skill-guidance.test.mjs
```

Expected: the new Grok resolver assertion returns `[]`, and the guidance assertion cannot find `@grok`.

## Task 2: Extend the generic runtime allowlist and skill guidance

**Files:**

- Modify: `src/main/runtime/orchestration/groups.ts`
- Modify: `skills/orchestration/SKILL.md`

- [ ] Add `'grok'` to `AGENT_NAME_GROUPS`; do not change `resolveGroupAddress` or `titleMatchesAgentNameGroup`.
- [ ] Add `` `@grok` `` to the `Group addresses include ...` sentence in the orchestration skill.
- [ ] Keep the list order stable and readable; place Grok with the other agent-name groups, before `@worktree:<id>`.
- [ ] Run the same focused command and require all tests to pass.

## Task 3: Verify scope and commit the implementation

**Files:**

- Verify: `src/main/runtime/orchestration/groups.ts`
- Verify: `src/main/runtime/orchestration/groups.test.ts`
- Verify: `skills/orchestration/SKILL.md`
- Verify: `config/scripts/orchestration-skill-guidance.test.mjs`

- [ ] Run formatting checks without rewriting unrelated files:

```bash
pnpm exec oxfmt --check \
  src/main/runtime/orchestration/groups.ts \
  src/main/runtime/orchestration/groups.test.ts \
  config/scripts/orchestration-skill-guidance.test.mjs
git diff --check
```

- [ ] Run the focused suites again from a clean command invocation.
- [ ] Run Node type checking because the runtime allowlist changes the `GroupAddress` type:

```bash
pnpm typecheck:node
```

- [ ] Confirm `git status --short` lists no files outside the four-file implementation scope.
- [ ] Review `git diff` for the exact matching contract and then commit:

```bash
git add \
  src/main/runtime/orchestration/groups.ts \
  src/main/runtime/orchestration/groups.test.ts \
  skills/orchestration/SKILL.md \
  config/scripts/orchestration-skill-guidance.test.mjs
git commit -m "fix: add Grok orchestration group"
```

- [ ] Send exactly one `worker_done` message using the live Orca dispatch preamble, including the commit hash, test results, and the four modified paths.
