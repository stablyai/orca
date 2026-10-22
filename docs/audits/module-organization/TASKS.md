# Orca module organization task tracker

Start with the small, quieter provider and backend areas, merge each PR, and build the next change on the merged result. Keep the session runtime, broadly shared contracts and terminal lifecycle work later in the queue. This tracker is the execution order; it supersedes the preliminary phase ordering in the [assessment](README.md) and [codebase map](CODEBASE-MAP.md).

The full plan accounts for all **2,008 files in the original 23 scopes**: **2,004 proposed relocations and four forwarding-module removals**. It breaks them into **88 provisional code PR batches**, with seven checkpoints and nine discovery tasks covering all 66 directories with more than 100 direct JS/TS files. These are review-sized planning units, not a PR quota or a promise to finish everything in a few days. Caller fanout and live development may require further splits; adjacent tasks can combine when they form one responsibility and remain easy to review. Record that adjustment before implementation and preserve file coverage.

Implementation has not started; G00 documentation publication is in progress. Every completion checkbox below is open. [execution-tracker.json](execution-tracker.json) is the authoritative structured tracker: it includes each batch's file actions, activity evidence, validation profile, export review, workflow predecessor, status, owner, PR URL, merge SHA and check records. Keep this checklist and the JSON in sync in each PR. Stable task IDs are local planning IDs, not GitHub PR numbers; never reuse an ID for unrelated work.

## Start here

- [ ] **G00 — Save and merge the documentation PR.** Include the original report, data, generator, this tracker and the narrow `.gitignore` allowlist. This makes the multi-day plan available on main.
- [ ] **PR00 — Linear IPC, seven files.** Move the six implementation modules and their existing test into `src/main/ipc/linear/`; import `linear/register-handlers` directly from registration composition. No directory-index resolution and no forwarding file at the old path.
- [ ] **PR01 — Jira IPC, ten files.** Apply the same pattern to Jira, preserving cancellation, site scope, channel names and handler registration order.
- [ ] Continue through the quiet-area queue, then complete **G01** before taking on broader changes.

Open one code-move PR at a time by default. Do not spend several days preparing a stack that will conflict with the rest of the team. Each merged PR should stand on its own, pass required checks and leave direct imports in their final form.

## How quieter work was selected

The bounded sample is the latest **1,000 first-parent commits at the audited checkout**, spanning **October 16–21, 2026**. It measures development edits, which predict merge conflict exposure; it does not measure product usage. It does not include unmerged work or other branches. Zero edits in this sample is a prioritization clue, not proof of an inactive feature.

| Scope                    | Commits editing scope | Commits editing outside callers |
| ------------------------ | --------------------: | ------------------------------: |
| `ipc-linear`             |                     1 |                               5 |
| `ipc-jira`               |                     1 |                               5 |
| `jira-attachments`       |                     0 |                               4 |
| `linear-issue-context`   |                     1 |                               2 |
| `settings-repository`    |                     1 |                               2 |
| `ephemeral-vm`           |                     3 |                               1 |
| `browser-cookie`         |                     0 |                               3 |
| `tooling-mobile-web`     |                     5 |                               6 |
| `cloud-relay-assignment` |                     3 |                              12 |
| `task-page-leftovers`    |                    12 |                               7 |
| `ipc-filesystem`         |                    14 |                              38 |
| `store-agent-status`     |                     9 |                              20 |
| `renderer-session-rules` |                    14 |                              59 |
| `codex-app-server`       |                     8 |                              29 |
| `claude-structured`      |                    19 |                              36 |
| `shared-jira`            |                     2 |                              30 |
| `shared-remote-runtime`  |                     8 |                             160 |
| `shared-native-chat`     |                    23 |                             119 |
| `shared-session`         |                    48 |                             267 |
| `mobile-native-chat`     |                    32 |                              27 |
| `runtime-session`        |                    32 |                              91 |
| `ipc-pty`                |                    20 |                              15 |
| `persistence-leftovers`  |                    31 |                             118 |

Caller activity uses the audit's entire outside-caller set for the scope, including tests; it is deliberately broader than the files any one sub-batch will edit. Production caller counts in the JSON are also scope-wide, not per-batch estimates. Refresh actual callers and their activity before implementation.

IPC goes first because its scopes are small and each has one outside production-classified caller. Jira attachments have no sampled edits, but image authorization deserves a focused review. Browser cookies are also quiet, yet touch credential and platform behavior, so they follow the first pilots. High-fanout shared contracts and busy session code come later. The sequence balances edit traffic, caller fanout and operational risk; sorting by a single edit count would miss those differences.

Before every new PR, inspect current main and available active-work information. If another change is touching this scope or its required callers, select the next quieter eligible task and record the revised order. `sequenceAfter` encodes the default workflow, not a proven code dependency. Resolve actual technical dependencies during preflight and record them in `technicalDependencies` before resequencing.

## Rules for every PR

**No barrels, including temporary ones.** No new `index.ts` aggregation, `export *` convenience surfaces, named re-export aggregators, old-path forwarding stubs, or folder imports that rely on an index. A named entry such as `register-handlers.ts` should implement registration; other callers import the concrete module that owns the behavior or type.

The source export review identified **52 production-classified modules with local forwarding exports**, including exports of imported bindings. Four are pure forwarding modules. Their tasks explicitly remove them and change consumers to the real owners:

| Forwarding module to remove                                         | Import the concrete owner                                                                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ephemeral-vm-recipe-runner.ts`                            | `src/shared/ephemeral-vm-recipe-runner.ts`                                                                                              |
| `src/renderer/src/components/task-page-github-task-kind.ts`         | `src/shared/task-github-search.ts`                                                                                                      |
| `mobile/src/session/mobile-native-chat-image-transcript-markers.ts` | `src/shared/native-chat-image-transcript-markers.ts`                                                                                    |
| `src/main/persistence.ts`                                           | The existing `persistence/loading-store/` and `persistence/applying-settings/` implementation files appropriate to each imported symbol |

For the other flagged modules, retain their implementation and remove convenience forwarding exports as their consumers switch to direct owners. Each task lists the relevant existing exports in `existingLocalReexports`. Review actual bindings, mock behavior and cycles; a path-only search cannot distinguish a type's owner from a forwarding API. Required external package export contracts remain explicit package boundaries, not a reason to create internal barrels.

Each PR follows this checklist:

1. **Refresh the scope.** Set owner and status; verify the source file list, existing target contents, test ownership, recent activity and current outside callers. Read applicable platform, Git and subtree instructions.
2. **Settle the destination.** Confirm concrete responsibility folders and final descriptive basenames. The JSON gives path proposals; its larger batches need semantic review. Avoid a second broad rename pass just to shorten every name.
3. **Bound the review.** Aim for 5–20 production modules. More than 25 production modules, 60 moved files or 100 caller/path-reference edits triggers a split review. Keep production/test pairs and platform twins together; assign cross-cutting integration tests by what they exercise rather than their prefix alone. Batch file counts do not include caller edits.
4. **Make the atomic change.** Move code and relevant tests, remove designated forwarding modules, and update all imports, mocks, runtime path strings, fixture-copying code, build entries, scripts and CI references in the same PR. Never bridge two batches with re-export shims.
5. **Preserve behavior.** Keep wire methods, IPC channels, stored formats, process output names, lifecycle order and lazy-loading boundaries stable. Keep API redesign, performance changes and unrelated formatting out of the move.
6. **Verify and review.** Run the affected existing tests, typechecks, formatting, changed-code quality and applicable CI gates. Apply the [refactor-audit skill](../../../.agents/skills/refactor-audit/SKILL.md): compare against the merge base, check moved bodies, literals, callers and wire names, and obtain an independent sub-agent review before merging. Inspect changed imports/exports for accidental aggregation, cycles and stale path strings. Preserve upstream fixes when rebasing and run the skill's merge-validation gate. Record commands, review findings and results.
7. **Merge and reconcile.** Record PR URL, merge SHA and actual file actions. Set status to `merged`, then `verified` after checking merged main. Update the map selectors, inventory, report and tracker at scope checkpoints so completed work does not remain a pending proposal. Start the next PR from updated main.

Do not mark a task complete when its PR opens or local tests pass. Preserve its full scope when splitting it; create child tasks with stable IDs and exact file ownership. If a file should stay in place, record a reviewed reason rather than silently dropping it. A failed move can be reverted as an atomic PR; restoring a barrel is not the recovery plan.

## Sequential PR checklist

`Files P/T` means production-classified files / test-support files in this batch. Production-classified includes tooling and declarations; the four removal tasks count their forwarding files in that column. `Edits` counts sample commits touching the batch's original paths. It excludes edits to its outside callers. PR scope also includes necessary caller and path-reference updates, which must be measured at preflight.

### Wave 1 Quiet provider backend and settings work

First merge milestone: PR00 and PR01. Continue one at a time through the remaining quiet scopes; G01 checks what the pilot taught us.

| Done | Task     | Proposed PR or checkpoint                                       | Files P/T | Edits |
| ---- | -------- | --------------------------------------------------------------- | --------: | ----: |
| [ ]  | **PR00** | Group Linear IPC handlers with direct registration imports      |       6/1 |     1 |
| [ ]  | **PR01** | Group Jira IPC handlers with direct registration imports        |       6/4 |     1 |
| [ ]  | **PR02** | Group Jira attachment discovery, images and cache ownership     |       9/6 |     0 |
| [ ]  | **PR03** | Group Linear issue-context reads and replace forwarding imports |      10/7 |     1 |
| [ ]  | **PR04** | Group repository identity and icon settings                     |       8/5 |     0 |
| [ ]  | **PR05** | Group repository hooks and host setup settings                  |      15/7 |     1 |
| [ ]  | **PR06** | Group source-control AI repository settings                     |       9/3 |     0 |
| [ ]  | **PR07** | Move repository settings composition and remaining fields       |       8/5 |     0 |
| [ ]  | **PR08** | Group ephemeral VM provisioning and cleanup                     |      11/6 |     3 |
| [ ]  | **G01**  | Review the first merged moves before expanding scope            |         — |     — |

### Wave 2 Quiet platform and tool subsystems

Cookie files had no edits in the sample, but their platform and credential ownership needs review. Tooling and cloud work follow; neither entails a deployment.

| Done | Task     | Proposed PR or checkpoint                                  | Files P/T | Edits |
| ---- | -------- | ---------------------------------------------------------- | --------: | ----: |
| [ ]  | **PR09** | Group Chromium cookie scanning and import steps            |       5/0 |     0 |
| [ ]  | **PR10** | Group cookie source detection, parsers and decryption      |      10/4 |     0 |
| [ ]  | **PR11** | Group cookie import orchestration, state and cleanup       |     10/28 |     0 |
| [ ]  | **PR12** | Group mobile web input and platform seam tools             |       5/3 |     0 |
| [ ]  | **PR13** | Group mobile web preview and evidence tools                |      12/3 |     1 |
| [ ]  | **PR14** | Group mobile web route and bundle analysis tools           |      7/45 |     5 |
| [ ]  | **PR15** | Group relay assignment modules and existing tests          |      8/20 |     3 |
| [ ]  | **G02**  | Reconcile quiet-area PRs and approve the busier-area queue |         — |     — |

### Wave 3 Desktop features and provider lifecycle

These are busier scopes. Keep provider and subsystem batches separate and refresh caller lists before every PR.

| Done | Task     | Proposed PR or checkpoint                                             | Files P/T | Edits |
| ---- | -------- | --------------------------------------------------------------------- | --------: | ----: |
| [ ]  | **PR16** | Finish the existing GitLab Task Page folder                           |       1/2 |     2 |
| [ ]  | **PR17** | Finish the existing Linear Task Page folder                           |      22/5 |     3 |
| [ ]  | **PR18** | Group Jira Task Page board behavior                                   |       6/5 |     0 |
| [ ]  | **PR19** | Group Jira Task Page creation and summary flows                       |       6/2 |     0 |
| [ ]  | **PR20** | Move Jira Task Page filters, issue lists and creation flows           |     24/26 |     0 |
| [ ]  | **PR21** | Group GitHub Task Page mutation ownership                             |      19/7 |     0 |
| [ ]  | **PR22** | Move GitHub Task Page reads, refresh and composition                  |      19/5 |     3 |
| [ ]  | **PR23** | Move cross-provider Task Page hooks and composition                   |      13/1 |     4 |
| [ ]  | **PR24** | Move cross-provider Task Page composition and pure view rules         |     15/15 |     5 |
| [ ]  | **PR25** | Consolidate local filesystem guards, import and search                |     11/13 |     2 |
| [ ]  | **PR26** | Group Parcel watcher child acquisition and termination                |      12/4 |     0 |
| [ ]  | **PR27** | Group the Parcel watcher process and supervisor                       |     19/16 |     2 |
| [ ]  | **PR28** | Group remote and WSL filesystem watchers                              |       9/5 |     5 |
| [ ]  | **PR29** | Consolidate local watcher lifecycle and events                        |     15/17 |     7 |
| [ ]  | **PR30** | Move filesystem request registration and integration suites           |      2/18 |     5 |
| [ ]  | **PR31** | Group agent-status records, contracts and reducers                    |      13/2 |     5 |
| [ ]  | **PR32** | Move agent-status actions, scheduling and slice composition           |     18/22 |     8 |
| [ ]  | **PR33** | Group renderer session launch records and publication                 |      12/4 |     2 |
| [ ]  | **PR34** | Group renderer session launch admission and requests                  |     24/15 |    12 |
| [ ]  | **PR35** | Group renderer session tab activation and cancellation                |       2/2 |     5 |
| [ ]  | **PR36** | Group Codex app-server protocol and handshake leaves                  |       9/2 |     3 |
| [ ]  | **PR37** | Move Codex app-server connection, session and teardown                |       5/9 |     8 |
| [ ]  | **PR38** | Group structured Claude launch options and model selection            |     16/15 |     9 |
| [ ]  | **PR39** | Group structured Claude journal translation and prompts               |      8/11 |     5 |
| [ ]  | **PR40** | Group structured Claude acquisition and session startup               |       9/3 |    10 |
| [ ]  | **PR41** | Move structured Claude session and dispatch lifecycle                 |     13/44 |    15 |
| [ ]  | **G03**  | Review desktop feature and process boundaries before shared contracts |         — |     — |

### Wave 4 Shared contracts and all consumers

Move each leaf group with all consumer updates atomically. Split further by concrete owner if caller churn exceeds the review-size prompt. Preserve mixed-version compatibility.

| Done | Task     | Proposed PR or checkpoint                                       | Files P/T | Edits |
| ---- | -------- | --------------------------------------------------------------- | --------: | ----: |
| [ ]  | **PR42** | Group shared Jira URL, query and status rules                   |       9/5 |     0 |
| [ ]  | **PR43** | Group shared Jira attachment and stream contracts               |       3/0 |     0 |
| [ ]  | **PR44** | Move shared Jira types, capabilities and saved-filter contracts |       9/5 |     2 |
| [ ]  | **PR45** | Group remote runtime requests and subscriptions                 |     18/12 |     4 |
| [ ]  | **PR46** | Group remote runtime shared-control lifecycle                   |      21/7 |     4 |
| [ ]  | **PR47** | Move remote runtime connection, handshake and socket rules      |     13/10 |     5 |
| [ ]  | **PR48** | Group shared native-chat tool, edit and diff rules              |     23/19 |     1 |
| [ ]  | **PR49** | Group shared native-chat prompts and session options            |     19/12 |     9 |
| [ ]  | **PR50** | Group shared native-chat transcript and row rules               |     24/19 |     9 |
| [ ]  | **PR51** | Group shared native-chat command, stream and provider rules     |      10/7 |     3 |
| [ ]  | **PR52** | Move shared native-chat command, stream and root contracts      |     22/16 |    13 |
| [ ]  | **PR53** | Group shared agent-session options and catalogs                 |     25/11 |     7 |
| [ ]  | **PR54** | Group shared agent-session journal contracts                    |       9/4 |     3 |
| [ ]  | **PR55** | Group shared agent-session requests, queue and send contracts   |      16/8 |    11 |
| [ ]  | **PR56** | Group shared agent-session failure and refusal rules            |      23/9 |    10 |
| [ ]  | **PR57** | Group shared agent-session records and stored forms             |       4/4 |     3 |
| [ ]  | **PR58** | Group shared agent-session lifecycle and provider identity      |     23/13 |    10 |
| [ ]  | **PR59** | Group shared agent-session projection and turn rules            |     24/15 |     8 |
| [ ]  | **PR60** | Group shared agent-session capabilities and availability        |      12/1 |    10 |
| [ ]  | **PR61** | Group shared agent-session context, approvals and questions     |       9/9 |     4 |
| [ ]  | **PR62** | Group shared agent-session conversation and message identity    |       7/3 |     3 |
| [ ]  | **PR63** | Move remaining agent-session capability and root contracts      |      19/9 |    15 |
| [ ]  | **G04**  | Verify shared consumers and mixed-version compatibility         |         — |     — |

### Wave 5 Mobile runtime terminal and persistence

These areas have substantial lifecycle or active-work risk. Revisit the order using current main. The persistence forwarding entry is removed, not moved.

| Done | Task     | Proposed PR or checkpoint                                        | Files P/T | Edits |
| ---- | -------- | ---------------------------------------------------------------- | --------: | ----: |
| [ ]  | **PR64** | Group mobile native-chat visual documents and media rendering    |      11/5 |     5 |
| [ ]  | **PR65** | Group mobile native-chat attachment and image ownership          |      10/5 |     2 |
| [ ]  | **PR66** | Group mobile native-chat composer, attachments and drafts        |     19/12 |     9 |
| [ ]  | **PR67** | Group mobile native-chat session options and queued editing      |      12/7 |     9 |
| [ ]  | **PR68** | Group mobile native-chat asks, permissions and prompts           |     20/15 |     3 |
| [ ]  | **PR69** | Group mobile native-chat tool, task and subagent rows            |       6/4 |     4 |
| [ ]  | **PR70** | Group mobile native-chat page and scroll ownership               |      17/6 |     3 |
| [ ]  | **PR71** | Group mobile native-chat message text and prose presentation     |     12/11 |     8 |
| [ ]  | **PR72** | Group mobile native-chat row and turn presentation               |     17/11 |    11 |
| [ ]  | **PR73** | Group mobile native-chat send state and terminal-stream coupling |     16/15 |     4 |
| [ ]  | **PR74** | Move mobile native-chat controller, send and session composition |     25/30 |    20 |
| [ ]  | **PR75** | Group runtime session records and durable store                  |     17/11 |     9 |
| [ ]  | **PR76** | Group runtime session claims, leases and process identity        |     15/15 |     7 |
| [ ]  | **PR77** | Group runtime session teardown and tab ownership                 |       8/5 |     2 |
| [ ]  | **PR78** | Move runtime session dispatch, teardown and tab lifecycle        |     19/39 |    27 |
| [ ]  | **PR79** | Move PTY IPC test harness and provider fixtures                  |      4/10 |     9 |
| [ ]  | **PR80** | Group PTY delivery, backpressure and drain behavior              |      4/15 |     1 |
| [ ]  | **PR81** | Consolidate PTY ownership, spawning and management suites        |      4/53 |    18 |
| [ ]  | **PR82** | Remove the persistence forwarding entry and import real owners   |       1/0 |     0 |
| [ ]  | **PR83** | Colocate persistence orcad migration tests and fixtures          |      0/10 |     8 |
| [ ]  | **PR84** | Colocate persistence terminal topology and lease tests           |      0/22 |    10 |
| [ ]  | **PR85** | Colocate persistence workspace and repository tests              |      0/20 |    14 |
| [ ]  | **PR86** | Colocate persistence settings and automation tests               |      0/15 |     7 |
| [ ]  | **PR87** | Colocate remaining persistence loading and security tests        |      0/17 |     7 |
| [ ]  | **G05**  | Verify lifecycle moves before the remaining-directory review     |         — |     — |

### Wave 6 Remaining directory dispositions

These are discovery tasks, not bulk move PRs. Each assigned directory needs an explicit keep, organize or deeper-design-review decision. Add exact implementation tasks for organize decisions.

| Done | Task    | Work                                                               | Coverage       |
| ---- | ------- | ------------------------------------------------------------------ | -------------- |
| [ ]  | **D00** | Review remaining terminal UI and daemon organization               | 3 directories  |
| [ ]  | **D01** | Review remaining desktop native-chat and provider organization     | 10 directories |
| [ ]  | **D02** | Review sidebar, tab bar and remaining workspace UI organization    | 5 directories  |
| [ ]  | **D03** | Review editor and remaining settings organization                  | 2 directories  |
| [ ]  | **D04** | Review remaining renderer libraries, runtime, state and components | 7 directories  |
| [ ]  | **D05** | Review mobile transport, tasks, components and session leftovers   | 7 directories  |
| [ ]  | **D06** | Review remaining host services, IPC and runtime organization       | 21 directories |
| [ ]  | **D07** | Review remaining shared contracts and root composition             | 6 directories  |
| [ ]  | **D08** | Review remaining tooling, cloud and integration-test organization  | 5 directories  |

### Final verification

Completion includes discovery-created work; it does not stop at the initial 23 scopes.

| Done | Task    | Work                                                         | Coverage                                     |
| ---- | ------- | ------------------------------------------------------------ | -------------------------------------------- |
| [ ]  | **G06** | Close the organization program with a refreshed codebase map | All completed scopes and directory decisions |

The file groups above are planning partitions, not proof of architectural independence. The JSON has exact source actions and proposed targets for every original file. Later tasks require boundary and caller review before execution; the currently small source counts of a shared-contract task can still conceal hundreds of consumer edits.

## Validation and merge evidence

Set `ORCA_BACKGROUND_LAUNCH=1` for all tests and agent-launched applications. UI checks, when needed, use the repository's Electron skill and hidden Playwright CDP; platform-native checks run in an isolated environment or CI. File moves alone do not require inventing new behavioral tests.

| Change                    | Required local validation to select from current callers                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop backend or IPC    | `pnpm tc:node`; existing moved tests and affected consumer/registration suites with `pnpm test`                                                                       |
| Renderer                  | `pnpm tc:web`; affected existing component, hook and store tests; node typecheck if its config explicitly includes a moved path                                       |
| Shared contracts          | `pnpm tc`; mobile typecheck and test typecheck; affected shared, desktop, CLI and mobile suites; cloud checks if actual cloud consumers are affected                  |
| Mobile                    | `pnpm --dir mobile typecheck`; `pnpm --dir mobile typecheck:tests`; affected suites through mobile's own test command                                                 |
| Filesystem workers or PTY | Desktop typecheck and lifecycle suites; rebuild affected entry sources and verify launch paths and stable output names; applicable Windows/WSL and macOS/Linux checks |
| Tooling                   | Existing tool/fixture/CI contract tests; affected generator verification; script-relative paths and generated output checks                                           |
| Cloud assignment          | Cloud workspace typecheck and tests; no deploy is part of this organization task                                                                                      |

Every PR also runs changed-code quality, changed-file formatting, `git diff --check` and its required CI checks. Applicable import-boundary and ratchet gates must pass without adding baseline exemptions. Preserve remote/local execution, mobile consumers, mixed-version compatibility and folder workspaces as well as git worktrees.

Fill in commands from the task's `validationProfile`; angle-bracket arguments in JSON are templates, not runnable literal paths. Attach check evidence like:

```json
{
  "status": "verified",
  "prUrl": "actual merged PR URL",
  "mergeCommit": "actual merge SHA",
  "checks": [
    { "command": "actual command with exact paths", "result": "passed", "commit": "checked SHA" }
  ],
  "notes": "Actual moves, direct-owner import changes and any approved scope refinement"
}
```

Keep the JSON as a durable record; do not regenerate it from the original snapshot and overwrite progress. The original `generate-map.mjs` updates `codebase-map.json` only. Retire or update completed selectors in `audit-plan.json` before rerunning it, because an empty selector deliberately fails. If early path moves change later callers, update later file actions and checks against current main without changing the baseline coverage record.

## Completion means a reconciled codebase

The program closes after the original scopes and any discovery-created implementation tasks are verified, every large directory has a recorded disposition, obsolete source paths and convenience forwarding exports are removed from the changed scopes, and the refreshed map reflects merged main. A remaining design-review decision is open work, not a completed cleanup.

Publish the merged PR list and before/after directory counts. Evaluate whether a contributor can find a responsibility and its concrete owners; file moves alone do not establish performance gains or prove every module is well designed.
