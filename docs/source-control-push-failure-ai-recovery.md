# Source Control Push Failure AI Recovery

## Problem

Push, force-push, publish, and sync push-stage failures flow through the shared
remote operation formatter in `src/renderer/src/lib/source-control-remote-error.ts:94`
and the editor-store toast paths in `src/renderer/src/store/slices/editor.ts:3716`
and `src/renderer/src/store/slices/editor.ts:3821`. A local pre-push hook or
lint hook is not an auth, protected-branch, or transport problem, so generic
remote guidance sends the user in the wrong direction.

PR #7787 proves the behavior is useful, but the prototype needs tightening before
it is maintainable:

- `src/renderer/src/components/right-sidebar/SourceControl.tsx:1938` and
  `src/renderer/src/components/right-sidebar/SourceControl.tsx:5799` repeat
  push-failure predicates and feed live branch/file state into a prompt that says
  "at failure time".
- `src/renderer/src/components/right-sidebar/use-source-control-recovery-ai.ts:63`
  imports push detection again instead of consuming one derived recovery model.
- `src/renderer/src/components/right-sidebar/source-control-ai-commit-failure-launch.ts:24`
  and `src/renderer/src/components/right-sidebar/source-control-ai-push-failure-launch.ts:24`
  are copied launch flows with action-specific copy.
- `src/shared/source-control-commit-failure-agent-command.ts:6` and
  `src/shared/source-control-push-failure-agent-command.ts:6` are identical
  command-template builders.
- `src/renderer/src/components/right-sidebar/source-control-fix-split-button.tsx:21`
  already contains a reusable split button, while `SourceControl.tsx:6415`
  carries a second inline version.
- `src/renderer/src/lib/source-control-remote-error.ts:148` currently treats
  any `isSync` error as push-like for hook detection. `syncBranch` calls the
  formatter for fetch, upstream-status, pull, and push failures, so the renderer
  cannot prove a sync error came from the push stage without an explicit marker.
- `src/renderer/src/components/right-sidebar/SourceControl.push-failure-recovery.test.ts:2`
  imports prompt helpers through the large React module instead of shared prompt
  modules.

## Goal

Add first-class recovery for pre-push hook failures without growing a parallel
push-only subsystem:

1. Toasts for push, force-push, publish, and sync push-stage failures say
   "blocked" for detected pre-push or lint-hook output.
2. Source Control shows a concise Push blocked panel with Details and AI Fix
   only for a failure snapshot that is both push-like and hook-like.
3. AI Fix launches the configured `fixPushFailure` Source Control action with a
   safe, provider-neutral prompt.
4. Commit-failure recovery and push-failure recovery share launch,
   command-template, split-button, and dense error-panel primitives.

## Non-goals

- Do not fix server-side pre-receive hooks, hosted CI failures, or provider-side
  protected-branch failures from this entry point.
- Do not bypass hooks, add `--no-verify`, push from the launched agent, create a
  PR, or assume GitHub-specific terminology.
- Do not add app-wide persistence for this transient failure panel.
- Do not redesign the Source Control panel or the Source Control AI settings
  model.
- Do not fold unrelated launch surfaces such as checks recovery into this change
  unless a tiny shared helper is already needed for commit/push recovery.

## Design

1. Keep push-hook detection and prompt building in shared code.
   - `src/shared/source-control-push-failure.ts` owns normalization, bounded
     scanning, summary text, Details eligibility, prompt truncation, prompt
     rules, and changed-file list bounding.
   - Detection must stay conservative: explicit `pre-push`/`prepush`,
     `hook declined to push`, hook-runner output in push context, or lint output
     in push context. Auth, non-fast-forward, protected branch, pre-receive,
     submodule, and generic transport failures stay on the existing remote-error
     path.
   - Keep the output scan bounded at 64 KiB and the prompt failure-output
     section bounded. Also cap prompt file lines to a small constant with an
     omitted-count line; do not rely on the git-status cap, which is far too high
     for prompt context.

2. Make remote-error formatting sync-stage aware.
   - Extend `RemoteOperationErrorOptions` with an explicit push-stage flag for
     sync, for example `isSyncPushStage`.
   - Gate push-hook classification on `isPush`, `isForcePush`, `publish`, or
     `isSyncPushStage`; do not use bare `isSync` as evidence of a push failure.
   - In `syncBranch`, pass the push-stage flag only inside the two inner
     `pushRuntimeGit` catch blocks. The outer fetch, upstream-status, and pull
     catches still pass `isSync` for Sync-shaped generic copy but must not render
     blocked hook copy.
   - Carry the same push-stage fact back to the renderer, either by tagging the
     thrown `Error` with a narrow exported marker or by wrapping it in a typed
     error that preserves the original message/cause. `SourceControl` must set
     `syncPushStage` only from that marker, not from `kind === 'sync'` plus
     hook-like stderr.
   - Keep submodule push messages before hook detection so submodule guidance
     remains more specific than AI recovery.

3. Replace one-off command builders with one shared recovery command builder.
   - Add a shared builder that accepts `{ actionId, promptOverride,
     commandInputTemplate, basePrompt }` and renders the existing Source Control
     AI command template for launch actions.
   - Keep compatibility exports for commit and push helpers if nearby tests or
     call sites still use those names, but make them wrappers over the generic
     builder.
   - Move prompt-builder tests to import from shared modules, not
     `SourceControl.tsx`.

4. Capture and derive push recovery state once.
   - Extend `SourceControlActionError` with the raw error, a push-stage marker
     for sync failures, the branch name at failure time, a bounded status-entry
     snapshot at failure time, and a per-worktree sequence token.
   - `runRemoteAction` clears the worktree's previous error and increments its
     sequence before starting. A catch may write an error only if its sequence
     still owns that worktree, so a slow failure cannot overwrite a newer retry
     or success.
   - Add a focused renderer helper that accepts the captured
     `SourceControlActionError` and the current branch name, then returns either
     `null` or a model with raw/sanitized detail text, summary, details flag,
     kind label, and AI prompt.
   - The helper returns `null` unless the operation is `push`, `force_push`,
     `publish`, or `sync` with the sync push-stage marker and
     `isPushHookFailure(rawError)` passes.
   - If the current branch is known and differs from the captured branch, hide or
     clear the model instead of launching an agent with wrong branch context.
   - Pass that single model to `useSourceControlAi` and `CommitArea`; neither
     prop construction nor `CommitArea` should repeat the push-hook predicate.

5. Use one generic recovery launcher for commit and push failures.
   - Replace the separate commit and push launch files with
     `source-control-ai-recovery-launch.ts`, or keep the old files as one-line
     wrappers if import stability is cheaper.
   - The generic launcher owns connection resolution, SSH/local agent discovery,
     saved-agent validation, agent-args validation, agent selection, terminal
     launch, focus, and success/failure toasts.
   - Resolve connection without collapsing local and unresolved states: read
     `const worktreeConnectionId = getConnectionId(worktreeId)`, use it when it
     is a string or `null`, and only fall back to `sourceRepoConnectionId` when
     the worktree lookup returns `undefined`. If the fallback is also
     `undefined`, show the workspace-connection error instead of launching
     locally. `null` means proven local; a string means SSH/remote.
   - Validate saved CLI args before agent detection or terminal creation. On
     Windows, keep using PowerShell-safe planning through
     `planAgentCliArgsSuffix(..., 'powershell')`.
   - Action-specific data is limited to action id, base prompt, empty-prompt
     copy, unavailable-agent copy, and success copy.

6. Keep the recovery hook thin.
   - `use-source-control-recovery-ai.ts` builds the commit prompt, accepts the
     already-derived push recovery prompt/model, keeps independent loading
     flags, and calls the generic launcher.
   - It should not import push-hook detection, resolve agents, or duplicate
     launch plumbing.

7. Extract and reuse the recovery UI.
   - Reuse or replace the existing
     `src/renderer/src/components/right-sidebar/source-control-fix-split-button.tsx`
     rather than adding another split-button component.
   - Move the dense recovery notice and Details dialog into focused renderer
     modules named for source-control recovery. Avoid `helpers`, `utils`, and new
     max-lines suppressions.
   - Reuse the same notice/dialog component for commit and push recovery with
     action-specific labels, summary, details, prompt, saved recipe, and launch
     callback.
   - Keep normal remote errors filtered out when a push recovery model is
     rendered, so the user does not see both Push blocked and generic remote
     error copy for the same failure.

8. Retain `fixPushFailure` in the existing Source Control AI action model.
   - The prototype already adds `fixPushFailure` to
     `src/shared/source-control-ai-actions.ts`; keep it as a launch action like
     `fixCommitFailure`.
   - Verify default settings, normalizers, global settings rows, repository
     override rows, labels, descriptions, and variable chips all include Push
     failure fixes.
   - Do not create a push-specific settings store or migration. Existing
     `normalizeSourceControlAiSettings` hydrates missing action defaults.

## Data Flow

- User clicks Push, Force Push, Publish Branch, or Sync.
- `runRemoteAction` clears that worktree's previous remote error, records a new
  sequence token, and starts the editor-store remote action.
- Git push fails and throws.
- `pushBranch` or sync's inner push-stage catch calls
  `resolveRemoteOperationErrorMessage` with push-like options. Sync fetch, pull,
  and upstream-status failures do not pass the push-stage flag.
- Sync's inner push-stage catch marks the rethrown error as push-stage so
  `runRemoteAction` can preserve `syncPushStage` in the captured snapshot.
- The formatter classifies hook output before auth/transport fallbacks only for
  push-like options and shows blocked toast copy.
- `SourceControl` catches the same error, and if the sequence still owns the
  worktree, stores `{ kind, rawError, message, syncPushStage, branchName,
  entriesSnapshot }`.
- The push recovery helper derives one `pushRecovery` model from that snapshot.
- `CommitArea` renders normal remote errors or the Push blocked recovery notice.
- AI Fix builds the `fixPushFailure` command input and launches the selected
  agent in the owning local or SSH runtime.

## Edge Cases

- Auth, missing repo, protected-branch, pre-receive, non-fast-forward, and
  transport failures must not show the Push blocked panel.
- Submodule push errors keep their existing specialized messages before
  push-hook detection.
- Sync failures from fetch, upstream-status, or pull stages must not show Push
  blocked, even if stderr contains words like "lint" or "hook".
- Create PR intent remote failures use the same `runRemoteAction` plumbing; if
  CommitArea is not visible, blocked toast copy is still required but no hidden
  panel work is needed.
- A newer remote operation for the same worktree must clear stale recovery state
  immediately and prevent an older in-flight failure from writing after it.
- Switching worktrees or branches must not show another worktree or branch's
  push failure.
- External edits or another Orca window may make the failure stale. Do not add
  cross-window persistence for this feature; rely on local retry/remount/branch
  mismatch clearing and list this as residual risk.
- Source Control AI hidden for a repo still shows the blocked notice and Details;
  it hides AI Fix.
- SSH worktrees must detect and launch agents on the owning connection, not a
  local fallback.
- Windows launch planning must continue to use PowerShell-safe agent args.
- Very large hook output and very large changed-file sets must be bounded before
  prompt generation.
- ANSI/control output must not leak into summaries or Details comparison logic.
  Details may show sanitized text while preserving enough line breaks for
  debugging.
- Empty custom command templates must stay empty so the launcher rejects them
  with a clear settings error.
- Prompt text must treat file paths, branch names, and hook output as data, not
  instructions.

## Test Plan

- Shared unit tests:
  - `src/shared/source-control-push-failure.test.ts` covers detection positives,
    auth/protected/pre-receive/non-fast-forward negatives, ANSI/control
    stripping, bounded scanning, details comparison, prompt output truncation,
    prompt file-list capping, and provider-neutral prompt rules.
  - Shared command-template tests cover the generic recovery builder plus
    commit/push wrappers, including empty templates and prompt overrides.
  - `src/shared/source-control-ai-actions.test.ts` covers `fixPushFailure`
    label, default template, variables, normalization, and action-list inclusion.
- Remote formatter and store tests:
  - `src/renderer/src/lib/source-control-remote-error.test.ts` covers push,
    force-push, publish, and sync push-stage blocked copy plus sync non-push
    stage negatives, auth/non-fast-forward/protected/pre-receive/submodule
    regressions.
  - `src/renderer/src/store/slices/editor.test.ts` covers the `pushBranch` toast
    path and both sync push-stage and sync non-push-stage toasts.
- Renderer model and UI tests:
  - A focused push recovery derivation test covers operation kind, sync
    push-stage marker, branch mismatch, stale sequence ownership, snapshot file
    entries, summary, details flag, prompt contents, and ordinary remote errors.
  - `CommitArea` tests cover the Push blocked notice, Details dialog, AI Fix
    visible/hidden, ordinary remote errors, no duplicate remote error when a push
    model exists, and unchanged commit-failure recovery rendering.
  - Settings tests cover global and repository Source Control AI action rows
    showing Push failure fixes.
- Launcher tests:
  - Generic recovery launcher tests cover commit and push action ids, invalid CLI
    args before detection, empty template rejection, unavailable saved agent,
    local versus SSH agent detection, successful launch/focus, and success copy.
- Checks:
  - Run targeted vitest files above, `pnpm typecheck`, `pnpm lint`, and
    `pnpm check:max-lines-ratchet`.

## UI Quality Bar

The Source Control recovery UI must match `docs/STYLEGUIDE.md`: monochrome,
quiet, dense, token-based, and consistent with adjacent commit-failure recovery.
Use existing shadcn `Button`, `DropdownMenu`, and `Dialog` primitives, lucide
icons, `card`/`border`/`destructive`/`muted` tokens, and the existing action
recipe row patterns. The Push blocked notice should keep the summary readable at
narrow right-sidebar widths, avoid nested cards, avoid new color values, show
stable split-button geometry while launching, and keep Details as progressive
disclosure for long hook output. Dialogs and dropdowns must remain usable in
light/dark mode and under SSH latency.

## Review Screenshots

1. Source Control after a simulated pre-push hook failure: Push blocked notice
   with summary, AI Fix, and Details.
2. Push failure Details dialog showing hook output and Fix with AI.
3. AI Fix customize-launch dialog for `fixPushFailure`.
4. Ordinary push auth/protected/remote failure state: regular remote error, no
   Push blocked notice.
5. Sync fetch/pull-stage failure state: Sync-shaped remote error, no Push
   blocked notice.
6. Source Control AI hidden for the repo: Push blocked notice and Details, no AI
   Fix.
7. Source Control AI settings showing the Push failure fixes launch recipe.
8. Adjacent commit-failure recovery notice still rendering correctly after the
   shared UI extraction.

## Rollout

1. Tighten shared push-failure classifier/prompt bounds and add the generic
   recovery command builder.
2. Make remote formatter/store sync-stage aware and update toast tests.
3. Add the `SourceControlActionError` snapshot/sequence data and one push
   recovery derivation helper.
4. Replace duplicated commit/push launchers with the generic recovery launcher
   and thin hook wiring.
5. Extract/reuse source-control recovery UI components, including the existing
   split-button module.
6. Verify `fixPushFailure` settings/default/normalizer coverage and i18n labels.
7. Update targeted tests and run typecheck, lint, and max-lines ratchet.
8. Validate rendered Electron states with screenshots before opening the PR.

## Lightweight Eng Review

- Scope: Reduced from PR #7787's push-specific parallel path to a shared
  recovery layer. Keep the feature limited to local pre-push/lint-hook detection,
  blocked copy, an inline recovery notice, Details, and AI launch. No persistence
  or provider-specific recovery.
- Architecture/data flow: Shared code owns classification, prompt text, and
  command-template rendering; the editor store owns stage-aware toast formatting;
  `SourceControl` owns transient worktree-scoped failure snapshots and sequence
  invalidation; the generic launcher owns local/SSH agent discovery and terminal
  launch.
- Failure modes covered:
  - Sync stage ambiguity: only the inner push stage may classify as hook-blocked.
  - Auth/protected/pre-receive/non-fast-forward/submodule/transport errors stay
    out of push recovery.
  - Branch or worktree switches suppress stale recovery models.
  - Per-worktree sequence tokens prevent older in-flight failures from
    overwriting newer retries or successes.
  - Empty custom templates, invalid CLI args, unavailable saved agents, missing
    worktree context, SSH host detection, and Windows shell planning fail before
    terminal launch.
  - Large or hostile hook output and file lists are bounded and treated as data
    in prompts.
- Test coverage required:
  - Shared classifier/prompt/command/action-model tests in `src/shared`.
  - Remote formatter and editor-store tests for push, force-push, publish, sync
    push-stage, and sync non-push-stage paths.
  - Renderer derivation and `CommitArea` tests for Push blocked, Details, AI Fix,
    hidden AI actions, stale branch/sequence, ordinary remote errors, and
    existing commit failure recovery.
  - Generic launcher tests for local/SSH, invalid args, saved-agent unavailable,
    empty template, and success launch.
  - Settings tests for global and repo Push failure fixes rows.
  - Electron validation for all required screenshots; no separate E2E is
    required if renderer tests cover the model and Electron validates the real UI.
- Performance/blast radius: No polling, watchers, migrations, or startup work.
  Runtime cost is one bounded classifier pass over at most 64 KiB, bounded prompt
  output, and a bounded file snapshot only when a remote action fails. Largest
  blast radius is the shared recovery UI and launcher used by existing commit
  failures, so commit recovery needs tests and a screenshot.
- UI quality bar: Match `docs/STYLEGUIDE.md` and adjacent Source Control density:
  token-based error state, stable split-button geometry, progressive Details
  disclosure, no nested cards, concise copy, light/dark compatibility, and
  visible disabled/loading state under SSH latency.
- Required review screenshots:
  1. Push blocked notice after pre-push hook failure.
  2. Push failure Details dialog with Fix with AI.
  3. `fixPushFailure` customize-launch dialog.
  4. Ordinary push auth/protected/remote failure with no Push blocked panel.
  5. Sync non-push-stage failure with no Push blocked panel.
  6. Source Control AI hidden: Push blocked without AI Fix.
  7. Source Control AI settings showing Push failure fixes.
  8. Existing commit-failure recovery notice after shared UI extraction.
- Residual risks: Classifier false positives remain possible for unusual local
  hook-runner output that mentions push context; keep tests biased toward
  preserving auth, protected-branch, and non-fast-forward behavior. Failure
  panels are renderer-local, so another Orca window or an external terminal can
  fix the problem while the old panel remains visible until local retry, remount,
  or branch/worktree change. Electron validation may need a mocked or temporary
  repo scenario to trigger a real pre-push hook without mutating user data.
