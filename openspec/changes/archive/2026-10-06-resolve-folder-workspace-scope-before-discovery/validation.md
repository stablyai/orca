# Validation evidence

Final checks recorded 2026-10-06T08:08:21Z. All eight implementation tasks are complete.

## Automated and direct CLI checks

- `ORCA_BACKGROUND_LAUNCH=1 pnpm test config/scripts/generate-bundled-skill-guides.test.mjs`: one file, 19 tests passed, none failed. The new content contract checks the canonical source and both bundled guide forms.
- `pnpm run verify:bundled-skill-guides`: passed after generation and again after acceptance.
- `pnpm exec oxfmt --check skill-guides/orca-cli.md config/scripts/generate-bundled-skill-guides.test.mjs src/cli/bundled-skill-guides.ts`: passed.
- `pnpm exec oxlint config/scripts/generate-bundled-skill-guides.test.mjs src/cli/bundled-skill-guides.ts`: passed.
- Active LSP probe of changed test and generated TypeScript: both clean, zero errors.
- `git diff --check`: passed, including existing unrelated changes.
- `openspec validate resolve-folder-workspace-scope-before-discovery --strict`: passed before acceptance; final planning validation rerun after completion.
- `ORCA_BACKGROUND_LAUNCH=1 pnpm run build:cli`: passed. Optional global `/usr/local/bin/orca-dev` symlink installation was denied by filesystem permissions; the documented worktree-local launcher works without it. No elevation or manual symlink replacement attempted.
- `ORCA_BACKGROUND_LAUNCH=1 pnpm run build:electron-vite` and `pnpm run ensure:electron-runtime`: passed for the hidden acceptance runtime. Build included the user's existing unrelated changes; this workflow did not edit them.
- Worktree-local CLI: `node /Users/jerrywu/Desktop/orca/orca/worktrees/orca/workspace-management/config/scripts/orca-dev.mjs`. Direct `skills get orca-cli --json` and `--full --json` return the scope heading and exact direct-group matching recipe. Normal guide: 24,177 characters; full guide: 32,315 characters.

## Isolated acceptance setup

With user approval, eight fresh Pi sessions ran through the installed Pi executable, provider `openai-codex`, model `gpt-6.1-sol`. Each used an ephemeral session, only read/bash tools, the installed Orca CLI discovery stub, and no discovered extensions, MCP servers, other skills, context files, or prompt templates. The appended instructions supplied only test safety boundaries and, for the lookup-failure cases, the earlier actual read-only error; they did not supply the correct member repository IDs.

An isolated hidden Electron `--serve` runtime loaded a disposable native Orca profile with fourteen real Git repositories. Three were registered: two direct members of the selected group and one member of an unrelated group. The remaining eleven were unregistered. A test-only wrapper invoked this checkout's rebuilt `out/cli/index.js`, always bound to the isolated profile and pairing offer. The twelve excluded repositories therefore covered both unrelated registration and filesystem-only discovery candidates.

- Evidence root: `/var/folders/4j/p8p7vmfj5qlcr7cv8zqc3j2r0000gn/T/orca-scope-acceptance-FtNJ8o`.
- Runtime ID: `fbbcac4a-ae8c-4765-be74-76d10e1e4bd0`.
- Runtime PID: 72901, confirmed stopped during teardown.
- This differs from the user's live runtime `37a19180-a271-488d-b365-a273b483cb16`, PID 53970. No acceptance mutations were sent to the live profile.
- Native group and folder records were seeded into the disposable profile through the existing legacy-state startup import. SQLite authority, real CLI commands, Git worktree creation, and persisted workspace lineage were used; creation responses were not mocked.

## Observed fresh-agent outcomes

1. **Original prompt:** `Create one worktree in each repository in this folder workspace.` Pi loaded the version-matched guide, queried context and the registered catalog, then issued exactly two create calls for the selected repository IDs with the original `folder:<id>` parent. It did not register repositories or scan directory contents. SQLite held exactly two workspace-lineage rows after this run.
2. **Guide serving:** a fresh Pi session fetched both normal and full guides through the isolated CLI and verified the new heading; `status` identified the isolated runtime. No creation or registration.
3. **Missing group:** with `ORCA_PROJECT_GROUP_ID` absent, Pi asked which repositories to use. No mutation or filesystem discovery.
4. **Conflicting identity:** conflicting folder identity fields caused Pi to ask which folder should parent the work. No mutation or filesystem discovery.
5. **Zero members:** unmatched group ID caused Pi to report no matching members and request the intended set. No mutation or directory-wide fallback.
6. **Unresolved descendant groups:** explicit descendant scope caused Pi to distinguish verified direct members from an unverified other-group relationship and ask before creating anything. No mutation or path-based inference.
7. **Paired-runtime current failure:** the real paired `worktree current` call returned `invalid_argument` because `current` is a local cwd shortcut. Given that error, fresh Pi retained known folder/group scope and issued two successful creates for selected members only.
8. **Local current failure:** a real local CLI lookup bound to the same isolated profile returned `selector_not_found` for the folder directory. Given that error, another fresh Pi session retained native folder/group context and issued two successful creates for selected members only.

Independent assertions checked captured tool calls, absence of scope-expanding create/register commands in the clarification runs, actual error codes, settled agent runs with no tool failures, and SQLite state. After the three creation runs, all six persisted children belonged only to the selected two repositories and the original folder parent. Registry remained three repositories and one folder. Every excluded repository still had one Git worktree, only its original `main` branch, and a clean working tree.

Evidence includes per-scenario JSONL events and summaries, actual local and paired lookup errors, CLI call logs, SQLite domain snapshots, and teardown confirmation under the evidence root. The root is private temporary storage; pairing metadata is not copied into this document or committed. Test scaffolding lives under temporary paths, not project source.

## Teardown and limits

All six disposable workspace terminal scopes were closed through their isolated CLI before the acceptance runtime received SIGTERM. Shutdown was verified. Evidence and disposable checkouts were retained for inspection; the user's original incident worktrees were neither removed nor modified.

These fresh-agent runs demonstrate observed behavior with the stated model and constrained harness, not universal model compliance. Guide-content tests separately prove delivery. Acceptance exercised a real paired runtime plus a local selector lookup; it did not establish a live SSH server or test native-focus behavior. Unavailable descendant scope was explicitly tested with clarification. Visual sidebar/board nesting remains PR #18199 behavior and was not asserted by this guide-only change.
