# Trae CLI Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display, filter, preview, and resume Trae internal CLI `0.200.19+` sessions in Orca's Agent Session History on local, WSL, and SSH hosts.

**Architecture:** Keep Trae as an independent AI Vault agent and introduce a shared rollout parser for the record format it shares with Codex. Trae-specific adapters own its roots, index, identity, and `traecli resume` command; existing renderer and mobile history components consume the resulting shared session rows unchanged.

**Tech Stack:** TypeScript, Node.js filesystem/path APIs, Vitest, Zod runtime validation, Orca AI Vault scanners, SSH filesystem providers.

## Global Constraints

- Target only Trae internal CLI `0.200.19+`, `~/.trae/cli/sessions/**/rollout-*.jsonl`, and `~/.trae/cli/session_index.jsonl`.
- Resume with `traecli resume <SESSION_ID>` from the recorded cwd; never inject `CODEX_HOME`.
- Do not add Trae deletion, archive, usage, account, or rate-limit behavior.
- Scan only `rollout-*.jsonl` and prune `*.artifacts` directories.
- Preserve local, folder-workspace, Git-worktree, WSL, SSH, macOS, Linux, and Windows behavior.
- Use `path.join` locally and `joinRemotePath` for remote hosts; do not hardcode platform separators.
- Preserve mixed-version behavior: old clients ignore unknown agent rows and new clients tolerate old hosts returning no Trae rows.
- Never add a `max-lines` disable or per-file max-lines increase.
- Do not introduce vague module names such as `helpers`, `utils`, `common`, or `misc`.
- Follow red-green-refactor: every production behavior begins with a focused failing test.

## File structure

New focused modules:

- `src/main/ai-vault/session-scanner-rollout-parser.ts`: shared append-only Codex-compatible rollout fold.
- `src/main/ai-vault/session-scanner-rollout-title-index.ts`: path-keyed local `session_index.jsonl` title cache.
- `src/main/ai-vault/session-scanner-trae-parser.ts`: Trae file/content/incremental parser adapter.
- `src/main/ai-vault/session-scanner-trae-fixtures.ts`: sanitized Trae `0.200.19` fixtures.
- `src/main/ai-vault/session-scanner-trae-parser.test.ts`: Trae parser contract tests.
- `src/main/ai-vault/session-scanner-rollout-cached-title.ts`: refreshes unchanged Codex or Trae cache entries from their index.
- `src/main/ai-vault/remote-session-scanner-rollout-index.ts`: remote path-keyed rollout title-index reader.

Existing modules retain narrow responsibilities:

- `session-scanner-codex-parser.ts` and `session-scanner-codex-title-index.ts` become compatibility wrappers over the shared rollout modules.
- `session-scanner-agent-sources.ts` owns Trae local/WSL roots and pruning predicates.
- `remote-session-scanner-sources.ts` owns the SSH Trae root and remote parser wiring.
- `ai-vault-resume-command.ts` owns the provider-specific resume invocation.
- The renderer is unchanged because it already resolves the existing Trae label and icon.

---

### Task 1: Extract the shared rollout parser without changing Codex behavior

**Files:**

- Create: `src/main/ai-vault/session-scanner-rollout-parser.ts`
- Create: `src/main/ai-vault/session-scanner-rollout-title-index.ts`
- Create: `src/main/ai-vault/session-scanner-rollout-parser.test.ts`
- Modify: `src/main/ai-vault/session-scanner-codex-parser.ts`
- Modify: `src/main/ai-vault/session-scanner-codex-title-index.ts`
- Test: `src/main/ai-vault/session-scanner-codex-parser.test.ts`
- Test: `src/main/ai-vault/session-scanner-codex-title-index.test.ts`

**Interfaces:**

- Produces:

```ts
export type RolloutSessionAgent = Extract<AiVaultAgent, 'codex' | 'trae'>

export async function parseRolloutSessionFile(args: {
  agent: RolloutSessionAgent
  file: FileWithMtime
  platform: NodeJS.Platform
  sessionHome: string | null
  executionHostId?: ExecutionHostId
}): Promise<AiVaultSession | null>

export async function parseRolloutSessionContent(args: {
  agent: RolloutSessionAgent
  file: FileWithMtime
  content: string
  platform: NodeJS.Platform
  sessionHome: string | null
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  readIndexedTitle?: (sessionId: string) => Promise<string | null>
  signal?: AbortSignal
}): Promise<AiVaultSession | null>

export function createRolloutSessionResumeState(args: {
  agent: RolloutSessionAgent
  file: FileWithMtime
  sessionHome: string | null
}): ResumableSessionParseState

export function readRolloutSessionIndexTitle(args: {
  sessionFilePath: string
  sessionHome: string | null
  sessionId: string
}): Promise<string | null>
```

- Preserves the existing public Codex function signatures so downstream callers do not change in this task.

- [ ] **Step 1: Write a failing shared-parser characterization test**

Create `session-scanner-rollout-parser.test.ts` with a Codex-identity fixture that calls the new shared API directly:

```ts
it('parses a Codex-compatible rollout through the shared fold', async () => {
  const file = fixtureFile('rollout-2026-08-10T10-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
  const session = await parseRolloutSessionContent({
    agent: 'codex',
    file,
    content: jsonLines([
      {
        timestamp: '2026-08-10T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd: '/repo/app' }
      },
      {
        timestamp: '2026-08-10T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Shared rollout question' }
      }
    ]),
    platform: 'darwin',
    sessionHome: null
  })

  expect(session).toMatchObject({
    agent: 'codex',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    cwd: '/repo/app',
    title: 'Shared rollout question'
  })
})
```

- [ ] **Step 2: Run the new test and confirm the red state**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts src/main/ai-vault/session-scanner-rollout-parser.test.ts
```

Expected: FAIL because `session-scanner-rollout-parser.ts` does not exist.

- [ ] **Step 3: Extract the title-index cache behind a path-keyed API**

Move the bounded signature cache and JSONL parsing from `session-scanner-codex-title-index.ts` into `session-scanner-rollout-title-index.ts`. Key the cache by the resolved `session_index.jsonl` path, not by agent name:

```ts
export async function readRolloutSessionIndexTitle(args: {
  sessionFilePath: string
  sessionHome: string | null
  sessionId: string
}): Promise<string | null> {
  const home = args.sessionHome ?? sessionHomeFromRolloutPath(args.sessionFilePath)
  if (!home) return null
  const indexPath = join(home, 'session_index.jsonl')
  return (await readIndexedTitles(indexPath)).get(args.sessionId) ?? null
}
```

Keep `readCodexSessionIndexTitle(filePath, codexHome, sessionId)` as a wrapper that supplies these three fields. Re-export the existing Codex test reset/introspection functions as aliases over the shared cache so current tests retain their contract.

- [ ] **Step 4: Extract the rollout record fold and keep Codex wrappers**

Move the parse state, clone, line consumption, worker exclusion, and finalization logic from `session-scanner-codex-parser.ts` into `session-scanner-rollout-parser.ts`. Parameterize accumulator identity and title lookup:

```ts
function createRolloutParseState(
  agent: RolloutSessionAgent,
  file: FileWithMtime
): RolloutSessionParseState {
  return {
    accumulator: createAccumulator({ agent, file, sessionId: sessionIdFromFileName(file.path) }),
    previousTotals: null,
    rejectedWorkerSession: false,
    sawSessionMeta: false,
    titleSource: null
  }
}
```

When finalizing, pass `codexHome: args.agent === 'codex' ? args.sessionHome : null`. Replace the body of each public Codex parser function with a delegation that supplies `agent: 'codex'` and the existing Codex home.

- [ ] **Step 5: Run shared and Codex regression tests**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ai-vault/session-scanner-rollout-parser.test.ts \
  src/main/ai-vault/session-scanner-codex-parser.test.ts \
  src/main/ai-vault/session-scanner-codex-title-index.test.ts
```

Expected: PASS with Codex session identity, title cache, token totals, worker exclusion, and resume behavior unchanged.

- [ ] **Step 6: Commit the behavior-preserving extraction**

```bash
git add src/main/ai-vault/session-scanner-rollout-parser.ts \
  src/main/ai-vault/session-scanner-rollout-title-index.ts \
  src/main/ai-vault/session-scanner-rollout-parser.test.ts \
  src/main/ai-vault/session-scanner-codex-parser.ts \
  src/main/ai-vault/session-scanner-codex-title-index.ts
git commit -m "refactor(ai-vault): share rollout session parsing"
```

---

### Task 2: Add local, WSL, cached, and resumable Trae history

**Files:**

- Create: `src/main/ai-vault/session-scanner-trae-parser.ts`
- Create: `src/main/ai-vault/session-scanner-trae-fixtures.ts`
- Create: `src/main/ai-vault/session-scanner-trae-parser.test.ts`
- Create: `src/main/ai-vault/session-scanner-rollout-cached-title.ts`
- Remove: `src/main/ai-vault/session-scanner-codex-cached-title.ts`
- Modify: `src/shared/ai-vault-types.ts`
- Modify: `src/shared/ai-vault-resume-command.ts`
- Modify: `src/shared/ai-vault-resume-command.test.ts`
- Modify: `src/main/ai-vault/session-scanner-types.ts`
- Modify: `src/main/ai-vault/session-scanner-agent-sources.ts`
- Modify: `src/main/ai-vault/session-scanner-agent-parser.ts`
- Modify: `src/main/ai-vault/session-scanner-parse-cache.ts`
- Modify: `src/main/ai-vault/session-scanner-incremental-fixtures.ts`
- Modify: `src/main/ai-vault/session-scanner-test-fixtures.ts`
- Modify: `src/main/ai-vault/session-scanner.test.ts`
- Modify: `src/main/ai-vault/session-scanner-parse-cache-agents.test.ts`
- Modify: `src/main/ai-vault/session-first-user-prompt-read.test.ts`
- Modify: `src/main/ai-vault/session-list-result-validation.test.ts`

**Interfaces:**

- Consumes: `parseRolloutSessionFile`, `parseRolloutSessionContent`, `createRolloutSessionResumeState`, and `readRolloutSessionIndexTitle` from Task 1.
- Produces:

```ts
export async function parseTraeSessionFile(
  file: FileWithMtime,
  platform?: NodeJS.Platform,
  executionHostId?: ExecutionHostId
): Promise<AiVaultSession | null>

export async function parseTraeSessionContent(args: {
  file: FileWithMtime
  content: string
  platform?: NodeJS.Platform
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
  readIndexedTitle?: (sessionId: string) => Promise<string | null>
  signal?: AbortSignal
}): Promise<AiVaultSession | null>

export function createTraeSessionResumeState(
  file: FileWithMtime
): ResumableSessionParseState
```

- [ ] **Step 1: Write failing Trae parser and resume tests**

Add a sanitized fixture whose `session_meta` intentionally lacks `payload.id`, matching installed Trae `0.200.19`:

```ts
export const TRAE_FIXTURE_SESSION_ID = '019fe968-ff04-7e43-8316-983ae577b782'

export function traeFixture(): IncrementalAgentFixture {
  return {
    agent: 'trae',
    fileName: `rollout-2026-08-10T10-03-20-${TRAE_FIXTURE_SESSION_ID}.jsonl`,
    seedLines: [
      JSON.stringify({
        timestamp: '2026-08-10T10:03:20.000Z',
        type: 'session_meta',
        payload: { cwd: '/repo/trae', model: 'trae-model' }
      }),
      JSON.stringify({
        timestamp: '2026-08-10T10:03:20.500Z',
        type: 'turn_context',
        payload: { cwd: '/repo/trae', model: 'trae-model' }
      }),
      JSON.stringify({
        timestamp: '2026-08-10T10:03:21.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Trae seed question' }
      })
    ],
    appendLines: [
      JSON.stringify({
        timestamp: '2026-08-10T10:04:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Trae incremental answer' }
      })
    ],
    truncatedLines: [
      JSON.stringify({
        timestamp: '2026-08-10T10:03:20.000Z',
        type: 'session_meta',
        payload: { cwd: '/repo/trae' }
      })
    ]
  }
}
```

In `session-scanner-trae-parser.test.ts`, assert filename UUID fallback, `agent: 'trae'`, cwd, model, preview, token totals, indexed title priority, malformed-line tolerance, and `codexHome: null`.

In `ai-vault-resume-command.test.ts`, add:

```ts
it('resumes Trae without Codex home routing', () => {
  const command = buildAiVaultResumeCommand({
    agent: 'trae',
    sessionId: TRAE_FIXTURE_SESSION_ID,
    cwd: '/repo/trae app',
    platform: 'darwin'
  })
  expect(command).toBe(
    "cd '/repo/trae app' && traecli resume '019fe968-ff04-7e43-8316-983ae577b782'"
  )
  expect(command).not.toContain('CODEX_HOME')
})
```

Add shell-specific assertions:

```ts
expect(
  buildAiVaultResumeCommand({
    agent: 'trae',
    sessionId: TRAE_FIXTURE_SESSION_ID,
    cwd: 'C:\\Users\\Ada Lovelace\\repo',
    platform: 'win32',
    shell: 'cmd'
  })
).toBe(
  'cd /d "C:\\Users\\Ada Lovelace\\repo" && traecli resume "019fe968-ff04-7e43-8316-983ae577b782"'
)

expect(
  buildAiVaultResumeCommand({
    agent: 'trae',
    sessionId: TRAE_FIXTURE_SESSION_ID,
    cwd: 'C:\\Users\\Ada Lovelace\\repo',
    platform: 'win32',
    shell: 'powershell'
  })
).toBe(
  "Set-Location -LiteralPath 'C:\\Users\\Ada Lovelace\\repo'; traecli resume '019fe968-ff04-7e43-8316-983ae577b782'"
)
```

- [ ] **Step 2: Run the parser and resume tests and confirm the red state**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ai-vault/session-scanner-trae-parser.test.ts \
  src/shared/ai-vault-resume-command.test.ts
```

Expected: FAIL because `trae` is not an AI Vault agent and the Trae parser is absent.

- [ ] **Step 3: Register Trae and its resume invocation**

Add `'trae'` to `AI_VAULT_AGENTS` and `trae: 'Trae'` to `AI_VAULT_AGENT_LABELS`. Extend the resume switch without sharing Codex environment behavior:

```ts
case 'codex':
case 'trae':
  return `${baseCommand} resume ${sessionArg}`
```

`defaultAiVaultResumeCommandBase('trae')` already resolves `TUI_AGENT_CONFIG.trae.detectCmd`, which is `traecli`.

- [ ] **Step 4: Implement the Trae adapter and parser routing**

Create `session-scanner-trae-parser.ts` as a narrow adapter:

```ts
export function createTraeSessionResumeState(file: FileWithMtime): ResumableSessionParseState {
  return createRolloutSessionResumeState({ agent: 'trae', file, sessionHome: null })
}

export function parseTraeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  executionHostId?: ExecutionHostId
): Promise<AiVaultSession | null> {
  return parseRolloutSessionFile({
    agent: 'trae',
    file,
    platform,
    sessionHome: null,
    executionHostId
  })
}
```

Implement `parseTraeSessionContent` with the same descriptor plus the supplied remote title reader. Add `case 'trae'` to `parseAgentSessionFile`.

- [ ] **Step 5: Add bounded local and WSL discovery**

Add `traeSessionsDir?: string` to `AiVaultScanOptions`, include it in `isolatedScanRoots`, and add the source:

```ts
const TRAE_SESSIONS_DIR = join(homedir(), '.trae', 'cli', 'sessions')

trae: {
  rootDirs: (options, wslHomeDirs) =>
    sessionRootDirs(options.traeSessionsDir ?? TRAE_SESSIONS_DIR, wslHomeDirs, [
      '.trae',
      'cli',
      'sessions'
    ]),
  extensions: ['.jsonl'],
  filePredicate: (filePath) => basename(filePath).startsWith('rollout-'),
  directoryPredicate: (name) => !name.endsWith('.artifacts')
}
```

Add a scanner fixture under a date hierarchy, a non-rollout JSONL decoy, and a `.artifacts` directory decoy. Extend the all-agents scanner assertion and assert the Trae resume command and workspace cwd.

Pin WSL root construction without touching a real distro:

```ts
expect(
  AI_VAULT_AGENT_SOURCES.trae?.rootDirs(
    { traeSessionsDir: '/Users/ada/.trae/cli/sessions' },
    ['/wsl/Ubuntu/home/ada']
  )
).toEqual([
  '/Users/ada/.trae/cli/sessions',
  join('/wsl/Ubuntu/home/ada', '.trae', 'cli', 'sessions')
])
```

- [ ] **Step 6: Add incremental parsing and lazy title refresh**

Add `traeFixture()` to `allIncrementalAgentFixtures()`. Add `case 'trae'` in `resumableStateFactoryFor` returning `createTraeSessionResumeState`.

Replace `refreshCachedCodexTitle` with `refreshCachedRolloutTitle`:

```ts
export async function refreshCachedRolloutTitle(
  candidate: SessionFileCandidate,
  session: AiVaultSession
): Promise<AiVaultSession> {
  const sessionHome = candidate.agent === 'codex' ? candidate.codexHome : null
  const title = await readRolloutSessionIndexTitle({
    sessionFilePath: candidate.file.path,
    sessionHome,
    sessionId: session.sessionId
  })
  return title && title !== session.title ? { ...session, title } : session
}
```

Call it for unchanged `codex` and `trae` entries. Add a Trae cache test that writes `session_index.jsonl` after the initial parse, rescans an unchanged transcript, and expects the indexed title with `stats.reused === 1`.

- [ ] **Step 7: Cover first-prompt and mixed-version validation**

Add a Trae case to `session-first-user-prompt-read.test.ts` using an `input_text` content block longer than the preview cap; expect the full prompt.

Add a result-validation case:

```ts
it('accepts Trae rows while preserving unknown-agent tolerance', () => {
  const parsed = parseAiVaultListResult({
    sessions: [
      { ...validSession('trae-session'), agent: 'trae', codexHome: null },
      { ...validSession('future-session'), agent: 'future-agent' }
    ],
    issues: [],
    scannedAt: '2026-08-10T00:00:00.000Z'
  })
  expect(parsed.sessions.map((session) => session.agent)).toEqual(['trae'])
  expect(parsed.issues).toEqual([])
})
```

- [ ] **Step 8: Run the complete local Trae test slice**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ai-vault/session-scanner-trae-parser.test.ts \
  src/main/ai-vault/session-scanner.test.ts \
  src/main/ai-vault/session-scanner-parse-cache-agents.test.ts \
  src/main/ai-vault/session-first-user-prompt-read.test.ts \
  src/main/ai-vault/session-list-result-validation.test.ts \
  src/shared/ai-vault-resume-command.test.ts
```

Expected: PASS; the all-agent assertion includes Trae, decoys are excluded, incremental parsing matches cold parsing, and Codex behavior remains green.

- [ ] **Step 9: Commit local Trae history support**

```bash
git add src/shared/ai-vault-types.ts \
  src/shared/ai-vault-resume-command.ts \
  src/shared/ai-vault-resume-command.test.ts \
  src/main/ai-vault
git commit -m "feat(ai-vault): surface local Trae CLI sessions"
```

---

### Task 3: Add SSH Trae discovery and remote title lookup

**Files:**

- Create: `src/main/ai-vault/remote-session-scanner-rollout-index.ts`
- Remove: `src/main/ai-vault/remote-session-scanner-codex-index.ts`
- Modify: `src/main/ai-vault/remote-session-scanner-sources.ts`
- Modify: `src/main/ai-vault/remote-session-scanner-types.ts`
- Modify: `src/main/ai-vault/remote-session-scanner.test.ts`

**Interfaces:**

- Consumes: `parseTraeSessionContent` from Task 2.
- Produces:

```ts
export function remoteRolloutIndexTitles(args: {
  provider: RemoteSessionFilesystemProvider
  sessionHome: string
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
  signal?: AbortSignal
}): Promise<Map<string, string>>
```

- [ ] **Step 1: Write a failing remote Trae test**

Add a `MemoryRemoteProvider` fixture containing:

```ts
provider.addFile(
  '/home/ada/.trae/cli/session_index.jsonl',
  jsonLines([{ id: TRAE_FIXTURE_SESSION_ID, thread_name: 'Indexed remote Trae title' }]),
  1
)
provider.addFile(
  `/home/ada/.trae/cli/sessions/2026/08/10/rollout-${TRAE_FIXTURE_SESSION_ID}.jsonl`,
  traeFixture().seedLines.join('\n'),
  10
)
provider.addFile(
  `/home/ada/.trae/cli/sessions/2026/08/10/rollout-${TRAE_FIXTURE_SESSION_ID}.artifacts/nested.jsonl`,
  '{}',
  11
)
```

Assert exactly one session with SSH host identity, Linux platform, indexed title, `codexHome: null`, and:

```ts
resumeCommand:
  "cd '/repo/trae' && traecli resume '019fe968-ff04-7e43-8316-983ae577b782'"
```

- [ ] **Step 2: Run the remote test and confirm the red state**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ai-vault/remote-session-scanner.test.ts -t "Trae"
```

Expected: FAIL because no remote Trae source exists.

- [ ] **Step 3: Generalize the remote rollout index reader**

Move the implementation from `remote-session-scanner-codex-index.ts` to `remote-session-scanner-rollout-index.ts`. Rename `codexHome` to `sessionHome`, retain cancellation behavior, and key `titleCaches` by the complete session home path:

```ts
const pending = readRemoteRolloutIndexTitles(
  args.provider,
  args.sessionHome,
  args.hostPlatform,
  args.signal
)
args.titleCaches.set(args.sessionHome, pending)
```

Update remote Codex sources to call the generic function without changing their `codexHome` field or deduplication behavior.

- [ ] **Step 4: Add the remote Trae source**

Add a source rooted with `joinRemotePath(hostPlatform, remoteHome, '.trae', 'cli', 'sessions')`. Apply both pruning rules remotely:

```ts
{
  agent: 'trae',
  rootDir: joinRemotePath(hostPlatform, remoteHome, '.trae', 'cli', 'sessions'),
  extensions: ['.jsonl'],
  filePredicate: (path) => remoteBasename(path).startsWith('rollout-'),
  directoryPredicate: (name) => !name.endsWith('.artifacts'),
  parse: (file, content, context) =>
    parseTraeSessionContent({
      file,
      content,
      platform: context.hostPlatform.os,
      executionHostId: context.executionHostId,
      executionHostPlatform: context.hostPlatform.os,
      signal: context.signal,
      readIndexedTitle: async (sessionId) =>
        (
          await remoteRolloutIndexTitles({
            provider: context.provider,
            sessionHome: joinRemotePath(context.hostPlatform, remoteHome, '.trae', 'cli'),
            hostPlatform: context.hostPlatform,
            titleCaches: context.titleCaches,
            signal: context.signal
          })
        ).get(sessionId) ?? null
    })
}
```

Implement `remoteBasename` by normalizing backslashes to `/` and taking the last non-empty segment so a Windows client scanning a POSIX host does not apply local path semantics.

- [ ] **Step 5: Run remote and Codex regression tests**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ai-vault/remote-session-scanner.test.ts \
  src/main/ai-vault/session-scanner-codex-dual-root.test.ts
```

Expected: PASS; Trae is discovered and titled remotely, the artifact decoy is ignored, and managed/default Codex homes still deduplicate and resume correctly.

- [ ] **Step 6: Commit SSH support**

```bash
git add src/main/ai-vault/remote-session-scanner-rollout-index.ts \
  src/main/ai-vault/remote-session-scanner-sources.ts \
  src/main/ai-vault/remote-session-scanner-types.ts \
  src/main/ai-vault/remote-session-scanner.test.ts
git add -u src/main/ai-vault/remote-session-scanner-codex-index.ts
git commit -m "feat(ai-vault): discover Trae sessions over SSH"
```

---

### Task 4: Verify the complete contract against tests and the installed Trae history

**Files:**

- Temporary test only: `src/main/ai-vault/session-scanner-trae-live-smoke.test.ts`
- Verify: all files changed by Tasks 1-3

**Interfaces:**

- Consumes: the complete local and remote Trae implementation.
- Produces: fresh evidence for focused behavior, type safety, repository quality gates, and the user's installed history.

- [ ] **Step 1: Run all focused regression tests together**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ai-vault/session-scanner-rollout-parser.test.ts \
  src/main/ai-vault/session-scanner-trae-parser.test.ts \
  src/main/ai-vault/session-scanner-codex-parser.test.ts \
  src/main/ai-vault/session-scanner-codex-title-index.test.ts \
  src/main/ai-vault/session-scanner.test.ts \
  src/main/ai-vault/session-scanner-parse-cache-agents.test.ts \
  src/main/ai-vault/session-first-user-prompt-read.test.ts \
  src/main/ai-vault/session-list-result-validation.test.ts \
  src/main/ai-vault/remote-session-scanner.test.ts \
  src/shared/ai-vault-resume-command.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run type and changed-file quality gates**

```bash
pnpm run typecheck
pnpm run check:code-quality:changed
pnpm run check:max-lines-ratchet
```

Expected: all commands exit 0 without a max-lines exemption.

- [ ] **Step 3: Add a temporary read-only live smoke test**

Create `session-scanner-trae-live-smoke.test.ts` for this verification run only:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

it.runIf(process.env.RUN_TRAE_LIVE_SMOKE === '1')(
  'discovers installed Trae sessions without exposing transcript bodies',
  async () => {
    const isolationRoot = await mkdtemp(join(tmpdir(), 'orca-trae-live-smoke-'))
    try {
      const result = await scanAiVaultSessions({
        ...isolatedScanRoots(isolationRoot),
        traeSessionsDir: process.env.TRAE_SMOKE_SESSIONS_DIR,
        unlimited: true
      })
      expect(result.sessions.length).toBeGreaterThan(0)
      expect(result.sessions.every((session) => session.agent === 'trae')).toBe(true)
      expect(result.sessions.every((session) => session.resumeCommand.includes('traecli resume')))
        .toBe(true)
    } finally {
      await rm(isolationRoot, { recursive: true, force: true })
    }
  }
)
```

- [ ] **Step 4: Run the live smoke without printing session content**

```bash
RUN_TRAE_LIVE_SMOKE=1 \
TRAE_SMOKE_SESSIONS_DIR="$HOME/.trae/cli/sessions" \
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ai-vault/session-scanner-trae-live-smoke.test.ts
```

Expected: PASS and at least one installed Trae session discovered. Test output contains only assertion status, never prompts, transcript records, auth data, or titles.

- [ ] **Step 5: Remove the temporary smoke test and verify the worktree**

Delete `src/main/ai-vault/session-scanner-trae-live-smoke.test.ts` with `apply_patch`, then run:

```bash
git status --short
git diff --check
git log -4 --oneline
```

Expected: no temporary smoke file, no whitespace errors, and the rollout refactor, local Trae support, and SSH Trae support commits visible.

- [ ] **Step 6: Perform a final requirement audit**

Confirm from fresh test output and diff inspection:

- `trae` is a distinct AI Vault identity with label and existing icon.
- only `rollout-*.jsonl` files outside `*.artifacts` trees are scanned.
- local, WSL, and SSH roots are path-safe.
- title index, previews, first prompt, model, tokens, and incremental append parsing work.
- resume uses `traecli resume` from cwd with no `CODEX_HOME` behavior.
- delete remains unsupported.
- unknown remote agent rows remain safely ignored.

No additional commit is needed unless verification exposes a defect; any defect starts a new failing test and a focused fix commit.
