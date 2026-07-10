# OpenCode Commit Message Stdin Delivery

## Problem

OpenCode's preset Source Control AI path passes the full generated prompt as the final `opencode run` argv positional. Commit-message prompts include branch, staged file summary, user instructions, and the staged patch. The patch is capped by `STAGED_DIFF_BYTE_BUDGET = 200_000`, but the implementation uses JavaScript string length, not encoded byte length, so argv can still be much larger than command-line limits on Windows and some POSIX/SSH wrapper paths before OpenCode starts.

Verified current code:

- `src/shared/commit-message-agent-spec.ts:24-32` defines `promptDelivery` as the argv/stdin contract for large diffs.
- `src/shared/commit-message-agent-spec.ts:322-337` sets OpenCode to `promptDelivery: 'argv'` and appends `prompt`.
- `src/shared/commit-message-plan.ts:108-123` already routes `promptDelivery === 'stdin'` into `stdinPayload`.
- `src/main/text-generation/commit-message-text-generation.ts:470-601` pipes local `stdinPayload` to child stdin.
- `src/main/providers/ssh-git-provider.ts:122-140` forwards `stdinPayload` as relay `stdin`; `src/relay/agent-exec-handler.ts:160-303` writes it to the remote child.
- `src/shared/commit-message-plan.test.ts:36` currently locks in the broken OpenCode argv behavior.

## Feasibility Gate

`opencode --version` on the local machine reports `1.15.13`. `opencode run --help` confirms the required args exist: `--model`, `--agent`, `--format`, and `--variant`, with optional `[message..]` positionals. It does not document stdin prompt input.

Shipping gate: before changing the preset, run a controlled smoke test using the exact no-message shape, and verify stdout clearly reflects the stdin prompt rather than an empty task:

```sh
printf '%s\n' 'Write: test commit' | opencode run --model <model> --agent build --format default
```

Also smoke `--variant <level>` if the selected model exposes thinking levels. If credentials, model access, or an unsupported OpenCode version block validation, do not treat `--help` alone as proof. If stdin fails, do not add an argv fallback; stop and choose a different no-argv transport or version-gated behavior.

## Root Cause

The planner and both local/SSH execution paths already know how to carry stdin payloads. The mismatch is the OpenCode preset args.

OpenCode is not the only argv-delivered path in the registry: Cursor and custom commands that explicitly use `{prompt}` still put prompts in argv. They are out of scope here and should not be described as fixed by this change.

## Non-Goals

- Do not change prompt wording, diff truncation, output cleanup, model discovery, or model selection.
- Do not change interactive OpenCode terminal launch behavior.
- Do not change GitHub/GitLab/provider review flows.
- Do not change Cursor argv delivery or custom command `{prompt}` semantics.
- Do not add a second OpenCode execution path.

## Design

1. Change the OpenCode preset spec to `promptDelivery: 'stdin'`.
2. Add a short why-comment near that setting: OpenCode prompt input can contain large staged diffs and must stay out of argv.
3. Remove `prompt` from OpenCode `buildArgs`. The preset args must be exactly `run --model <model> --agent build --format default`, plus `--variant <thinkingLevel>` when present.
4. Keep `modelSource`, `modelDiscovery`, default model, and dynamic-model fallback behavior unchanged.
5. Keep preset `agentCommandOverride` behavior unchanged: an override such as `npx opencode` prefixes the same OpenCode args, while the prompt remains `stdinPayload`.
6. Accept the shared-spec blast radius: OpenCode prompts for commit-message, PR-field, and branch-name generation all move to stdin because they all call `planCommitMessageGeneration(...)`. If the requirement is commit-message-only, this design is wrong and needs operation-aware delivery instead.

## Data Flow

- Source Control AI receives a staged context and builds the prompt. The context is not atomic: branch, staged summary, and staged patch are read by separate git commands before generation.
- `planCommitMessageGeneration(...)` validates the agent, model, and thinking level against the existing dynamic/static model rules.
- Because OpenCode becomes stdin-delivered, the planner passes an empty prompt into `buildArgs` and stores the real prompt in `plan.stdinPayload`.
- Local generation writes `stdinPayload` to the child process stdin.
- SSH generation serializes the same plan to the relay as `{ stdin: plan.stdinPayload }`, and the relay writes it to the remote child process stdin after spawn.

This fix removes the prompt from process argv only. It does not reduce prompt memory, model latency, token use, or diff truncation pressure. Remote execution still sends the prompt in one JSON-RPC frame; the relay frame cap is 16 MB, and today's prompt budget is under that, but future budget increases must account for it.

## Edge Cases

- Large staged diff: the prompt must be absent from `args`, including no empty-string placeholder.
- Thinking level selected: preserve `--variant <level>`.
- No thinking level selected: omit `--variant`.
- Dynamic OpenCode model not present in the seed catalog: preserve the existing dynamic fallback and still pass the selected model id.
- Agent command override: `npx opencode` becomes `binary: 'npx'`, `args: ['opencode', 'run', ...]`, with prompt in `stdinPayload`.
- Windows batch shims: removing the prompt from argv also removes prompt metacharacters from the batch command line; do not route the prompt through `{prompt}` for this preset.
- SSH: the prompt is JSON-serialized as `stdin`, not shell-quoted, and is written by the relay after spawn.
- SSH payload size: this is safe for the current prompt budget, not an unbounded transport. Anything near 16 MB needs streaming or another transport.
- OpenCode ignores stdin: the smoke test must catch this before shipping because `--help` does not document stdin.
- Output cleanup remains unchanged; OpenCode stderr/status chatter should be handled by existing failure and cleanup logic.

## Consistency And Concurrency

- No cache invalidation is introduced. Each generation plans from the request's current settings and the staged context supplied to that request.
- The staged context is not a true snapshot. If the index changes between the summary and patch reads, or after the context is read, the generated message can describe a mixed or stale view. That is existing behavior and not fixed here.
- Multiple windows can request generation for the same worktree. Local execution does not serialize same-`cwd` requests; the cancel map is keyed by `operation:local:<cwd>` and the newest request overwrites the reachable cancel token. Do not claim this change fixes local multi-window races.
- SSH execution queues matching `operation + cwd` lanes inside a `SshGitProvider` instance. The relay itself tracks only one active child per lane and cancels a prior active child if another request for the same lane reaches it, which matters if separate provider instances/windows bypass the same queue.
- Settings or command overrides changed while a generation is in flight affect the next request only; the current child keeps its immutable plan.

## Test Plan

- `src/shared/commit-message-agent-spec.test.ts`: add OpenCode coverage asserting `promptDelivery === 'stdin'`, no prompt or empty placeholder in `buildArgs`, variant preservation, and no variant when absent.
- `src/shared/commit-message-plan.test.ts`: update OpenCode expectations so `stdinPayload` receives the prompt and argv excludes it; include an OpenCode command-override case.
- Because `planCommitMessageGeneration(...)` is reused by commit-message, PR-field, and branch-name generation, the plan tests are the main regression coverage for the shared blast radius.
- Keep existing Codex stdin, custom-command stdin, local child stdin, SSH provider, and relay stdin tests passing.
- Run targeted Vitest for the touched shared tests, plus `pnpm typecheck` and `pnpm lint` for the implementation branch.
- Run the OpenCode stdin smoke test from the feasibility gate. If it cannot run, do not mark implementation risk as resolved.

## Lightweight Eng Review

- Scope: shared preset-agent plumbing and shared tests, with an explicit shared-operation blast radius for OpenCode commit-message, PR-field, and branch-name prompts. No renderer redesign, settings migration, hosted review flow, or provider-specific review behavior.
- Architecture/data flow: use the existing `promptDelivery` contract; local and SSH execution already honor `stdinPayload`.
- Failure modes covered: prompt re-enters argv, `--variant` is dropped, unknown dynamic model ids regress, command overrides change stdin behavior, remote JSON-RPC frame limits are ignored, or OpenCode accepts the flags but ignores stdin.
- Performance/blast radius: no renderer, watcher, IPC subscription, or startup cost. Local argv shrinks; remote payload size is unchanged because the prompt still crosses JSON-RPC as stdin data in one frame.
- UI quality bar: no visual change; skip visual-design review.
- Screenshots: none required for this headless invocation change. If PR evidence is needed, prefer unit-test output and the controlled OpenCode stdin smoke result.
- Residual risk: OpenCode stdin prompt input is not documented by `opencode run --help`; remote hosts may have different OpenCode versions; existing local multi-window cancellation races and staged-context non-atomicity remain.

## Rollout

1. Update OpenCode spec delivery and args.
2. Update shared spec and planner tests.
3. Run targeted tests, typecheck, lint, and the OpenCode smoke test before shipping.
