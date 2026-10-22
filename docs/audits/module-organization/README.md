# Orca file and folder organization assessment

**Yes: clean up the busiest directories in small, domain-focused steps.** The repeated prefixes often describe folders that should exist, or existing folders whose organization is incomplete. Keep kebab-case for ordinary filenames. The problem is how many unrelated responsibilities sit beside each other and how hard it is to find their owners.

This is a navigation and maintainability investment. Moving files alone does not make the application faster or establish better architecture. It becomes valuable when a contributor can find a feature, understand its entry points, and make a change without searching several enormous directories.

Start with the seven Linear IPC files and ten Jira IPC files, then Jira attachments, Linear issue context, repository settings and ephemeral VM ownership. Follow the quieter platform and tooling work before the busier Task Page and filesystem folders. Schedule the shared contracts, terminal lifecycle and session runtime work with their owners; those areas have broader compatibility and integration obligations. The [execution task tracker](TASKS.md) defines the full sequence.

This assessment proposes moves; it applies none. The accompanying [codebase walkthrough](CODEBASE-MAP.md) explains the system, and [codebase-map.json](codebase-map.json) contains the measured directory inventory, dependency summaries and exact proposed paths. [audit-plan.json](audit-plan.json) holds the editable architectural labels and proposals.

The [execution task tracker](TASKS.md) now provides the authoritative PR sequence, starting with quieter areas based on recent development activity. It refines the original phase suggestions below into smaller batches and explicitly removes existing forwarding modules. [execution-tracker.json](execution-tracker.json) records file actions, checks and merge progress; no barrel exports or old-path shims are allowed.

## What the filenames are telling us

Your example is a sound instinct. A prefix can act as a folder name written repeatedly:

```text
Current: src/main/ipc/
  linear.ts
  linear-issue-handlers.ts
  linear-project-handlers.ts
  linear-team-handlers.ts
  linear-custom-view-handlers.ts
  linear-ipc-args.ts
  linear.test.ts

Proposed: src/main/ipc/linear/
  register-handlers.ts
  issue-handlers.ts
  project-handlers.ts
  team-handlers.ts
  custom-view-handlers.ts
  ipc-args.ts
  register-handlers.test.ts
```

The proposed registration file still exports the same registration function. The `linear:*` channel names stay the same. A source-path cleanup should not change the external contract.

However, the backend already has [`src/main/jira`](../../../src/main/jira) and [`src/main/linear`](../../../src/main/linear). There is no reason to combine everything mentioning Jira into one repository-wide folder. Jira UI, authenticated backend access, IPC handlers and pure contracts have different jobs and run in different environments. Group by domain **within the appropriate layer**:

```text
src/main/jira/                     backend client and domain operations
src/main/ipc/jira/                 desktop request handlers, proposed
src/main/runtime/rpc/methods/      remote request methods
src/shared/jira/                   pure contracts and rules, proposed
src/renderer/src/components/
  task-page/jira/                  existing provider UI
```

These are related locations, not necessarily duplicate implementations. The [feature trails](CODEBASE-MAP.md#follow-a-feature-through-the-codebase) connect them.

## Where the problem is substantial

The following counts are JS/TS files directly in a directory, including its tests and support files. They do not include children. A directory with many colocated tests is less concerning than the same count of production modules, so the JSON also separates those categories.

| Directory                                   | Direct files | Assessment                                                                                            |
| ------------------------------------------- | -----------: | ----------------------------------------------------------------------------------------------------- |
| `src/shared`                                |        2,905 | Largest discovery problem; partition contracts and pure rules by domain.                              |
| `src/renderer/src/lib`                      |        1,292 | Too many unrelated rules and adapters behind one role-based name; introduce concrete domain children. |
| `src/main/runtime`                          |        1,251 | Keep runtime composition visible; group owned session, workspace and transport responsibilities.      |
| `src/renderer/src/components/terminal-pane` |        1,070 | Already a feature folder; needs smaller responsibilities inside it, not another `terminal/` wrapper.  |
| `config/scripts`                            |          987 | Organize tool families by purpose; grouping everything named `check-*` would mix unrelated owners.    |
| `src/renderer/src/components/settings`      |          838 | Repository settings are a good first section to group.                                                |
| `src/renderer/src/components/native-chat`   |          813 | Review composer, journal presentation and interaction boundaries separately.                          |
| `src/renderer/src/components/sidebar`       |          807 | Review concrete sidebar responsibilities; keep host facts separate from view state.                   |
| `src/main/ipc`                              |          797 | Provider families and incomplete filesystem/PTY consolidation are clear candidates.                   |
| `src/renderer/src/components/editor`        |          776 | Extend the existing responsibility-based organization; do not move every editor file at once.         |
| `mobile/src/session`                        |          722 | Separate mobile chat, terminal and session-navigation responsibilities.                               |
| `src/renderer/src/components`               |          619 | Finish the existing Task Page subtree before inventing a new feature hierarchy.                       |

The complete directory inventory covers the whole tracked repository, including cloud, mobile, native code, tooling and documentation. The proposed work is a selected backlog, not an assertion that every other directory is already well organized.

## The strongest findings

### Complete the organization that is already there

Task Page already has `jira/`, `linear/`, `github/` and `gitlab/` children, yet many `task-page-*` and `use-task-page-*` files remain in the parent components directory. The [Task Page entry](../../../src/renderer/src/components/task-page/TaskPage.tsx) reaches out to those hooks through parent-relative imports. This is direct evidence of one feature spread across two discovery locations. Route provider-specific files into the existing provider children and keep cross-provider composition at the feature root.

Filesystem and PTY code have the same pattern: existing [`ipc/filesystem`](../../../src/main/ipc/filesystem) and [`ipc/pty`](../../../src/main/ipc/pty) trees coexist with flat `filesystem-*`, `parcel-watcher-*` and `pty-*` families. Consolidate by the responsibilities already established inside those trees. Filesystem watchers include a separately built process entry, so this is more involved than the provider IPC pilot.

[`src/shared/linear`](../../../src/shared/linear) already groups issue types, workspace types, links, media and agent-access contracts. There are no direct `linear-*` JS/TS files left in `src/shared` in this snapshot. Jira's equivalent flat family is a concrete place to follow that precedent.

### A feature folder can itself be too flat

`browser/`, `claude/`, `codex/`, `terminal-pane/` and mobile `session/` already have meaningful names. Wrapping each in another folder does not solve their problem. Useful next boundaries are responsibilities such as browser cookies, structured Claude sessions, the Codex app-server adapter and the mobile chat composer.

There is an existing local example in [`editor/combined-diff`](../../../src/renderer/src/components/editor/combined-diff): children include `browse-files`, `load-sections`, `resolve-changes`, `review-controls`, `scroll-viewport` and `remember-view`. Those names help someone find an operation. It is a useful organization model, though the folder layout alone does not prove that its implementation is otherwise ideal.

### Keep composition visible and scrutinize excessive fragmentation separately

The [root store](../../../src/renderer/src/store/index.ts) explicitly composes named Zustand slices, and [OrcaRuntime](../../../src/main/runtime/orca-runtime.ts) composes host responsibilities. These entry points should remain easy to find. Moving their related files into domain folders does not require hiding the composition behind `index.ts` re-export files.

The repository also enforces file-size limits: generally 300 counted lines for TS, 400 for TSX, 600 for MJS and 800 for tests, with existing exceptions tracked by a ratchet. That policy encourages splitting large files. It does not tell contributors where the resulting modules belong. Add folder guidance alongside it. The audit does not establish that this rule caused the current directory sizes.

The Task Page entry also chains many staged hooks. Folders will improve discoverability, but whether that composition has too many stages is a separate design review. Do not use a file-move PR to silently rewrite state ownership or behavior.

## Naming rules I would adopt

- Create a folder when files describe one feature or responsibility with an identifiable owner. Three or more production modules is a useful review prompt, not an automatic rule.
- Prefer completing an existing folder to creating a parallel one. Keep tests and their fixtures with the code they exercise, preserving special shared fixture locations where needed.
- Remove a prefix when the enclosing path already supplies that exact context and the shorter name stays informative: `jira/attachments/image-cache.ts` is clearer than repeating `jira-attachment-` everywhere.
- Retain meaningful context when ambiguity would hurt search or review. `agent-session/journal-position.ts` is more useful than `agent-session/position.ts`. A descriptive kebab-case filename is healthy.
- Use concrete entries such as `register-handlers.ts`, `read-context.ts` or a named slice file. Avoid new `utils`, `helpers`, `common`, or catch-all folders. Avoid a forest of one-file folders and generic `manager.ts` files.
- Keep a small root for composition and entries. Add another level when distinct responsibilities emerge; do not mechanically convert every hyphen into a path separator.
- Keep imports explicit. A new folder does not require an `index.ts` that re-exports every internal file. A folder provides navigation; an enforced boundary or a real package provides stronger isolation.

The first small proposals shorten redundant prefixes. Most larger proposals retain basenames initially so a reviewer can verify the relocation easily. Shortening those names can follow after the boundary is settled. No global case-style migration is needed.

## How to pursue the cleanup

Phase 1 contains independently selectable pilots. Start with **one provider IPC family**. Linear and Jira are lower-risk choices because the selected files are desktop transport handlers around existing backend domains. Lower risk does not mean no validation is needed. Issue-context, attachments and VM code have more lifecycle or permission concerns and should follow after the pilot establishes the process.

Phase 2 completes existing trees and groups clearer subdomains. Phase 3 handles broadly shared contracts and lifecycle code after ownership review. Priority and risk are independent: shared contracts have high navigation value but also high migration cost.

The dependency evidence makes that sequencing concrete. Each provider IPC proposal has one outside production-classified caller. The shared agent-session scope has 1,085, while Jira's shared scope has 176. The flat persistence scope contains only one production-classified module among 85 files, yet 209 outside production-classified files import that scope. Moving a central entry can create substantial churn even when its neighbors are mostly tests. These counts include type imports and reflect direct callers in this snapshot, not runtime coupling or transitive impact.

The exact scope, file counts, outside callers and destinations for all proposals are in [the backlog table](CODEBASE-MAP.md#cleanup-backlog) and `codebase-map.json.proposals`. Broad proposals must be split into smaller changes; the JSON is an inventory of candidate ownership, not an executable bulk-move plan.

For each implementation PR:

1. Select a concrete responsibility and inspect its incoming callers and outgoing dependencies. Agree its public entry and identify any generated inputs, runtime entries, fixtures or compatibility fences.
2. Move production files with their relevant tests. Update imports, source-reading tests, aliases, package exports, build entry tables, scripts and CI references. Search for both full paths and entry basenames; the import graph cannot find every path string.
3. Keep exported APIs, channel names, wire formats, stored formats, registration order and lifecycle behavior stable. Keep semantic redesign in a separate review.
4. Run the affected tests and typechecks. Use desktop checks for desktop moves, mobile's independent checks for mobile/shared consumers and cloud's checks for cloud work. Run applicable boundary and ratchet checks; path moves must not add baseline exceptions to make CI pass.
5. Verify packaged worker/process entries when affected, including Windows/WSL and macOS/Linux behavior. Shared-contract changes need mixed-version client/server coverage; workspace changes need both folder workspaces and git worktrees.

For the first Linear IPC PR, the concrete change is seven file moves plus caller updates. Check its registration composition, the Linear IPC tests and desktop typechecking. The [main build-entry table](../../../config/build-plugins/main-build-entry-points.ts) becomes particularly relevant for later watcher and worker-related moves. Existing [compatibility import fences](../../../config/scripts/check-compat-boundary-imports.mjs) and the [process-host import boundary](../../../config/scripts/check-process-host-imports.mjs) should remain intact.

Judge success by whether a contributor can locate and change one responsibility in one obvious subtree, with explicit composition and a reviewable diff. Raw filename length, folder count and a lower sibling count are supporting signals, not success on their own. There is no defensible runtime-speed or engineering-hours savings estimate from this static audit.

## Keeping the evidence useful

Run from the repository root with its existing Node and pnpm dependencies installed:

```sh
node docs/audits/module-organization/generate-map.mjs
node docs/audits/module-organization/generate-map.mjs --check
```

The first command refreshes only `codebase-map.json` and records the checkout commit as snapshot provenance. The second preserves that recorded commit while recomputing and strictly comparing every measured field, including the source-content hash. Committing the audit or other changes outside the measured inventory therefore does not make an otherwise identical snapshot stale. The recorded commit must have a valid full Git object ID; checking does not require its historical object to be available in a shallow checkout. Both commands read Git-tracked paths with current working-tree contents and exclude this audit's own artifacts. Newly added source files must be tracked before they enter the inventory. The hash covers JS/TS paths and contents, not every repository asset.

The generator reuses the repository's tracked-file inventory, AST module-specifier parser, test classifier and root workspace source resolver. Human judgments live in `audit-plan.json`; changing those judgments requires review. After moves land, remove or update completed selectors before regeneration: an empty selector deliberately fails rather than silently retaining an obsolete proposal. Update the prose tables when refreshing the data; the generator does not rewrite the report.

The import graph includes type-only imports and recognized literal loaders. It counts direct file dependencies, not calls or runtime loading cost. Computed paths, `new URL`, filesystem reads, spawn/worker strings, package scripts and CI path references require separate inspection. Unresolved specifiers and parse failures are recorded explicitly. Folder size and repeated-prefix families identify places to inspect; the families overlap and must not be summed.
