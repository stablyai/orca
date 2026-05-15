# AI Commit Message Drafts

## Goal

Add an opt-in Source Control affordance that drafts a commit message from the staged diff. The user remains in control: Orca fills the commit message textarea, and the user edits or discards the draft before clicking Commit.

This is not an auto-commit feature.

## Reference Model

T3code has the right architectural split:

- Git code prepares commit context: staged file summary and staged patch.
- Text-generation code owns the prompt, provider invocation, structured result, and sanitization.
- Commit orchestration consumes a resolved message without knowing provider details.

Orca should use that split, but keep the user action more explicit than T3code's automatic generation during commit. Orca should use an IDE-style draft button in the existing commit area.

Relevant T3code reference files:

- `/Users/thebr/source/repos/public/t3code/apps/server/src/textGeneration/TextGeneration.ts`
- `/Users/thebr/source/repos/public/t3code/apps/server/src/textGeneration/TextGenerationPrompts.ts`
- `/Users/thebr/source/repos/public/t3code/apps/server/src/vcs/GitVcsDriverCore.ts`

## Implementation Strategy

Work from the contributor branch for PR #1487 and push the refactor back to that PR. Do not rewrite the feature from scratch unless the branch proves too hard to salvage.

Branch workflow:

1. Save or commit this planning doc before switching branches.
2. Check out PR #1487 locally.
3. Review the branch with this plan in hand.
4. Refactor the existing feature into the T3code-style boundaries below.
5. Keep the contributor's useful UI/settings/test work wherever it survives the boundary change cleanly.
6. Push the branch back to the contributor PR.

Target outcome: keep the PR's product richness, but change the code shape so Source Control is not the owner of agent/provider architecture.

## User Experience

In the Source Control commit area:

- Show a small `Sparkles` button in or next to the commit textarea.
- Only show the button when AI commit message drafts are enabled in Settings.
- Enable the button only when:
  - the active worktree has staged changes,
  - the commit message textarea is empty,
  - there are no unresolved merge conflicts,
  - no commit or generation request is already in flight for that worktree.
- On click, generate from staged changes only.
- While generation runs, show an inline spinner.
- On success, fill the textarea only if it is still empty.
- If the user types while generation is running, preserve the user's text and drop the generated draft.
- On failure, show an inline error near the commit area.

The primary Commit button behavior does not change.

## Settings

Add settings under Settings -> Git:

```ts
enableAiCommitMessageDrafts: boolean
commitMessageDraftAgent: 'auto' | 'codex' | 'claude'
```

Defaults:

- `enableAiCommitMessageDrafts: false`
- `commitMessageDraftAgent: 'auto'`

Also include the richer settings that are already useful in the contributor PR:

```ts
commitMessageDraftModelByAgent: Partial<Record<'codex' | 'claude', string>>
commitMessageDraftEffortByAgent: Partial<Record<'codex' | 'claude', string>>
commitMessageDraftCustomInstructions: string
```

The settings UI should expose:

- agent selection,
- model selection for the selected agent,
- effort selection only when the selected model supports it,
- custom instructions appended to the base prompt.

Arbitrary custom command templates are optional. They are useful for power users, but they are a different risk profile from model/custom-prompt settings because they require command parsing, quoting rules, and support for arbitrary binaries. If we keep that PR feature, it should live behind the same generation planner boundary described below and remain argv-based with no shell evaluation.

## Architecture

The desired architecture is T3code-style layering:

1. Git prepares staged context.
2. Shared commit-message code prepares the prompt contract and sanitizes the result.
3. A text-generation service resolves provider/model/effort and invokes the selected agent.
4. Source Control calls IPC and renders state.

The existing PR mostly has the right feature pieces, but the pieces are arranged around "commit message generation needs to run agent CLIs." The refactor should arrange them around "text generation produces a structured commit message from git context."

### Shared Prompt And Result Module

Create a concrete shared module, for example:

`src/shared/commit-message-generation.ts`

Responsibilities:

- Define request and result types.
- Build the commit message prompt.
- Truncate large sections with an explicit `[truncated]` marker.
- Sanitize generated output.
- Format `{ subject, body }` into the final commit message string.

Suggested types:

```ts
export type CommitMessageDraftAgent = 'auto' | 'codex' | 'claude'

export type CommitMessageDraftContext = {
  branch: string | null
  stagedSummary: string
  stagedPatch: string
}

export type CommitMessageDraftOptions = {
  agent: CommitMessageDraftAgent
  model?: string
  effort?: string
  customInstructions?: string
}

export type GeneratedCommitMessage = {
  subject: string
  body: string
  message: string
}
```

Prompt rules:

- Return only commit-message text. The shared module normalizes the first line
  into a safe subject and preserves an optional body.
- Subject is imperative, at most 72 characters, and has no trailing period.
- Body is either an empty string or short bullet points.
- Capture the primary user-visible or developer-visible change.
- Use only staged changes as context.
- Append custom instructions in a separate bounded section so user style guidance cannot crowd out the staged context.

### Agent Catalog And Planning

Keep a shared planner, but make it subordinate to the text-generation boundary:

`src/shared/commit-message-generation-plan.ts`

Responsibilities:

- Define supported agents, models, and effort levels.
- Validate persisted settings against that catalog.
- Produce a provider execution plan: binary, argv, stdin payload, display label.
- Support Codex and Claude first.
- Optionally support custom commands if the PR implementation is retained.

This is the right place to reuse the PR's model catalog, effort metadata, custom command tokenizer, and argv planner. The important boundary is that renderer and git code should never know CLI-specific flags.

### Git Context Collection

Add a provider-level method that can work locally or over SSH:

```ts
getStagedCommitContext(
  worktreePath: string
): Promise<{
  branch: string | null
  stagedSummary: string
  stagedPatch: string
} | null>
```

Local implementation:

- `git branch --show-current`
- `git diff --cached --name-status`
- `git diff --cached --patch --minimal --no-color --no-ext-diff`

Return `null` when there are no staged changes.

SSH implementation should route through `SshGitProvider`, so the staged diff is collected from the host that owns the worktree. The PR already attempts remote-host agent execution through the relay; keep that if it reviews cleanly, but make it a text-generation provider concern rather than a git-provider concern.

### Main Process Text Generation Service

Add or shape a main-process service around text generation, for example:

`src/main/text-generation/commit-message-text-generation.ts`

Responsibilities:

- Accept commit-message context plus generation options.
- Resolve the configured agent, model, effort, and custom instructions.
- Invoke Codex or Claude non-interactively.
- Enforce a timeout.
- Parse structured JSON output.
- Normalize provider errors into short user-facing messages.

Use Orca's existing command knowledge:

- `src/main/codex-cli/command.ts` for Codex and Claude binary resolution.
- `settings.agentCmdOverrides` where applicable.

Avoid shell evaluation. Spawn a binary with argv.

The contributor PR's local generator and prompt/error parsing are reusable, but should be shaped into this service boundary instead of letting the Source Control feature own all provider details directly.

If the PR's remote-host generation is retained, treat relay execution as a provider execution detail behind this service. The git provider may collect remote staged context, but it should not become the owner of model selection or provider-specific CLI flags.

### IPC And Preload

Add renderer API:

```ts
git.generateCommitMessageDraft(args: {
  worktreePath: string
  connectionId?: string
}): Promise<
  | { success: true; message: string; agentLabel?: string }
  | { success: false; error: string }
>
```

Main IPC flow:

1. Validate `worktreePath`.
2. Resolve local vs SSH git provider from `connectionId`.
3. Collect staged commit context.
4. Return a clear error if there are no staged changes.
5. Read settings to choose the draft agent, model, effort, and custom instructions.
6. Generate and return the formatted message.

### Renderer Integration

Update `CommitArea` in `src/renderer/src/components/right-sidebar/SourceControl.tsx`.

Thread through props for:

- whether generation is enabled,
- whether generation is running,
- generation error,
- generate action callback,
- disabled reason/title.

Keep generation state per worktree, matching the existing commit-in-flight pattern, so switching worktrees cannot leak disabled or error state into another worktree.

When generation resolves, compare the current draft against the empty state captured at request start. Only write the generated message if the current draft is still empty.

## Out Of Scope For V1

- Auto-committing after generation.
- PR title/body generation.
- Branch name generation.
- Inferring repo conventions from commit history.
- Streaming partial output.

The PR already had remote-host AI execution and cancellation. The refactor
keeps that behavior, but routes it through the text-generation execution
boundary so the SSH git provider only supplies remote staged context and a
relay executor.

## PR Reuse Strategy

The existing PR contains useful feature work. Prefer refactoring it into this architecture over rewriting everything.

Keep or adapt:

- Sparkles-in-textarea UX.
- Per-worktree generation state and "do not overwrite typed text" behavior.
- Settings UI for agent, model, effort, and custom instructions.
- Codex/Claude model catalog and effort metadata.
- Prompt truncation, output cleanup, and user-facing error extraction.
- Unit tests around prompt building, model planning, error extraction, and CommitArea behavior.

Refactor before merge:

- Move provider/model/custom-prompt details behind the shared generation planner and main text-generation service.
- Keep git context collection in the git provider layer.
- Keep renderer integration focused on UI state and IPC calls.
- If keeping remote relay execution, expose it through text-generation execution plumbing, not through Source Control or git context code.
- If keeping custom command templates, keep the tokenizer/planner shared and argv-based, with no shell evaluation.
- Prefer a shared text-generation model setting shape if Orca expects PR text, branch names, or other generated Git text soon. If commit messages remain the only consumer for now, keep the setting names commit-message-scoped but avoid coupling them to Source Control components.

Review carefully:

- Arbitrary custom command templates.
- Relay-side non-interactive execution.
- Cancel/tree-kill logic on Windows and SSH.
- Attribution appending. It may be useful, but it should be a deliberate product decision because generated commit messages are still user-authored drafts.

## Tests

Add focused unit tests for:

- Prompt construction includes branch, staged summary, staged patch, and truncation markers.
- Sanitization trims output, caps subject length, removes trailing periods, and supplies a fallback subject.
- Local IPC collects staged context and calls the generator.
- SSH IPC routes staged context collection through the SSH git provider.
- Settings validation falls back safely when persisted agent/model/effort values are stale.
- Custom instructions are included in the prompt and truncated independently.
- `CommitArea` enables generation only with staged changes and an empty message.
- Generated results do not overwrite text typed while generation is in flight.

Add one manual smoke test:

1. Stage a small change.
2. Enable AI commit message drafts.
3. Click the sparkles button.
4. Verify the textarea receives an editable message.
5. Type into the textarea during a slow generation and verify the generated result does not overwrite the typed text.

## Implementation Order

1. Check out PR #1487 and map each new file to one of the target layers: git context, shared prompt/result, planner/catalog, text-generation execution, IPC/preload, settings UI, Source Control UI, relay execution.
2. Preserve the existing UI and settings behavior while moving provider-specific logic out of `SourceControl.tsx` and git-provider orchestration.
3. Extract or rename shared prompt, truncation, formatting, and sanitization into the shared prompt/result module.
4. Extract or adapt the PR's agent/model/effort catalog into the shared planner module.
5. Move local and relay execution behind the main text-generation service.
6. Keep staged commit context collection in local and SSH git providers.
7. Rewire IPC so it collects context, reads settings, calls the text-generation service, and returns a draft result.
8. Port useful PR tests into the new module boundaries.
9. Run typecheck, lint, and the focused unit tests before pushing back to the PR branch.
