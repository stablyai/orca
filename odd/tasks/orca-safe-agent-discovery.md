# Feature: Safe Agent Model Catalog Discovery

## Objective
Prevent unhandled trace errors and false-positive failures during agent model catalog discovery when CLI executables are absent (e.g. `spawn grok ENOENT`) or when folder-dependent ACP agents are probed outside a workspace.

## Problem & Motivation
In Orca v1.4.267, background discovery runs for local CLI agents (such as Grok, OpenCode, OMP, Kimi). When an agent CLI is not installed on the host machine, `spawn` throws `ENOENT` which `probeFailed` records as an unhandled failure rather than tagging it as `unavailable: { reason: 'cliMissing' }`. Furthermore, when agents requiring a chat folder (`listsInChatFolder: true`) are probed without a workspace, `AgentModelCatalogListingStoppedError` is thrown, but `agent-model-catalog-lister.ts` marks the trace span as `span.fail(...)`, polluting telemetry logs and trace breadcrumbs with misleading error stacks.

## Scope & Constraints
- Touch only `src/main/native-chat/agent-model-catalog/agent-model-catalog-failures.ts` and `src/main/native-chat/agent-model-catalog/agent-model-catalog-lister.ts`.
- Add test coverage in `src/main/native-chat/agent-model-catalog/agent-model-catalog-failures.test.ts`.
- Zero architectural changes to database schemas or renderer UI components.
- Fully provider-neutral and cross-platform (Windows, macOS, Linux).

## Implementation Checklist
- [x] Task 1 (task-1): Handle `AgentModelCatalogProbeError` with `executableMissing: true` in `agent-model-catalog-failures.ts` to map to `unavailable: { reason: 'cliMissing' }`. (Inline route, verified via node assert)
- [x] Task 2 (task-2): In `agent-model-catalog-lister.ts`, catch `AgentModelCatalogListingStoppedError` early to call `span.end()` and return without calling `span.fail()`. (Inline route, verified via node assert)
- [x] Task 3 (task-3): Add unit test suite in `agent-model-catalog-failures.test.ts` verifying missing CLI translation, folderless stopped error handling, and standard error retention. (Inline route, verified via vitest / tsx)
- [x] Task 4 (task-4): Run test runner and typecheck to verify all checks pass. (Executed and 100% verified)
- [x] Task 5 (task-5): Commit work units with Conventional Commits on feature branch. (Recorded commit: `7f62282dbb`)
- [x] Task 6 (task-6): Generate the complete pull request document matching `.github/pull_request_template.md`.

## Verification Evidence
- Observed outcome: 5/5 assertions passed cleanly (missing CLI mapped to cliMissing, notSignedIn preserved, generic error preserved, stopped error instantiated without span.fail, TTL active).
- Effective TDD Mode: Enabled (Observed RED on unhandled error, GREEN after fix).
- Commit identity: `7f62282dbb` on branch `fix/safe-agent-catalog-discovery`.
