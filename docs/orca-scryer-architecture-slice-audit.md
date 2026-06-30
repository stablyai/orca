# Orca Scryer Architecture Slice Audit

Date: 2026-06-30

Status: **PASS for the current Architecture product slice release gate**.

This audit checks the already migrated Architecture product slice. It does not
claim full Scryer 33-operation parity. A row is only `covered` when the evidence
shows the relevant entrypoint, engine seam, `.scryer` state effect or no-write
property, reload/visible feedback, and error envelope where applicable. There is
no `partial` passing state.

## Release Gate Commands

| Layer | Command | Result |
| --- | --- | --- |
| Type/contract | `corepack pnpm run tc` | passed |
| Engine semantics | `corepack pnpm exec vitest run --config config/vitest.config.ts src/main/scryer/engine/*.test.ts src/main/scryer/engine/**/*.test.ts` | passed: 15 files, 45 tests |
| Adapter/IPC | `corepack pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/architecture.test.ts src/main/ipc/architecture-view-ipc.test.ts src/main/ipc/architecture-edit-session-ipc.test.ts src/main/scryer/mcp-tools.test.ts` | passed: 4 files, 46 tests; includes `person.add`, edit-session IPC, and strict MCP alias matrix |
| Renderer/session | `corepack pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/architecture/*.test.ts src/renderer/src/lib/session-write-subscriber.test.ts src/renderer/src/lib/workspace-session-patch.test.ts` | passed: 9 files, 68 tests |
| Tabs/session cascade | `corepack pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/store/slices/tabs.test.ts src/renderer/src/store/slices/store-session-cascades.test.ts` | passed: 2 files, 128 tests |
| Live Electron e2e | `SKIP_BUILD=1 corepack pnpm exec playwright test tests/e2e/architecture-tab.spec.ts tests/e2e/architecture-human-checklist.spec.ts tests/e2e/architecture-session-regression.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1` | passed: 22 tests, 7.6m |

## Workflow Matrix

| Workflow | Entry | Backend path | File effect | Visible/reload evidence | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Architecture tab lifecycle and default read | Command palette / Architecture tab | `readArchitectureView` and default `readModel` route through `readView(...)`; no fallback after read errors | No accidental non-default file creation; watch start does not create legacy default | Active model shows `model.scry`; panel renders strict nodes | covered | Evidence: `architecture-tab.spec.ts`, `architecture.test.ts`, `architecture-view-ipc.test.ts`. |
| Default model authoring from blank project | Visible add/start controls | `executeScryerOperation(...)` for intent add and `readView(...)` refresh | Writes `.scryer/planned.scry`; default `.scryer/model.scry` is not synthesized by planned edits | Tree/canvas updates after add/edit/delete | covered | Node/link/source/group basics are covered by live tests. |
| Project model lifecycle beyond default model | Create/save-as/delete/list model APIs | IPC handlers call project-model store helpers | Non-default `.scry` files created/copied/deleted in IPC tests | Not part of the stable Architecture 0.3 release-critical path | scoped out | Default `model.scry` is the release target. Non-default model manager UX can be added later without blocking #28/#29. |
| External file change loop | Real `.scryer/model.scry` / `.scryer/planned.scry` writes and watcher | Watcher filters files and reloads the active Architecture layer | Real active-model edits are written; `.editor.tmp`, `model.baseline.scry`, `model.presync.scry`, temp files are ignored | Live UI updates from "Watched Before" to "Watched After" and ignores temporary Scryer files | covered | Evidence: `architecture-human-checklist.spec.ts` "refreshes the UI for real model edits but ignores temporary Scryer files" and session regression coverage. |
| Strict/incompatible model handling | Load/reload strict model and rejected `flows` input | `readArchitectureView` returns standard envelope; no legacy default/fallback | Invalid `planned.scry` with `flows` remains rejected | UI renders unsupported-field error | covered | Evidence: `architecture-tab.spec.ts`, `architecture.test.ts`, `useArchitectureModelSession.test.ts`. |
| Source-map editor loop | Source-map rows and canvas source link | `scryer.source.update` via `executeOperation(...)`; source links open Orca editor | Boundary/sourceMap rows persist to `.scryer/model.scry` or `.scryer/planned.scry` | Rows stay visible; editor opens `src/index.ts` | covered | Evidence: source save and editor-open e2e plus IPC changed-file mapping. |
| AI/agent entrypoints | Build with AI, Fill with AI, Advisor Review | Default-model Fill/Advisor prompt reads now go through `readView(...)`; sync uses edit-session APIs | Prompt prep is read-only; sync writes `.implementing`, baseline/sync files, and planned/model state through controller | Terminal opens once; duplicate Build guarded; sync controls lock/unlock | covered | Prompt seam fixed in this audit; covered by `architecture-view-ipc.test.ts` and live e2e. |
| Sync/edit session safety | Start/cancel/auto-finish sync | `ScryerEditSessionController`, completion gate, `scryer.plan.fold` when allowed | `.implementing`, presync/baseline and model state updated/restored | Editing controls disable during sync; cancel restores state; auto-finish unlocks | covered | Evidence: `architecture-tab.spec.ts`, `architecture.test.ts`, engine lease/fold tests. |
| Session persistence | Clean Electron relaunch | Session persistence patch/subscriber writes Architecture tab state | `orca-data.json` contains Architecture tabs and active group/tab ids | Relaunch restores panel and model state | covered | Evidence: `architecture-tab.spec.ts`, session patch/subscriber tests. |
| Code-level Architecture workflow | Code-level rack buttons and model-property editor | Code-level add routes through symbol/add semantics; node property changes route through node update | Operation/process/model nodes and properties persist | Code-level rack and cards visible | covered | Evidence: `architecture-human-checklist.spec.ts` and renderer helper tests. |
| Node/link/source/drift semantic edits | Visible inspector/canvas controls | `scryer.node.update/delete`, `scryer.link.add/update/delete`, `scryer.source.update`, `scryer.drift.get/reconcile` | Writes planned state or sync anchors as appropriate | Tree, edge editor, diff badge, drift report and toast update | covered | Evidence: main live Architecture e2e and focused engine/IPC tests. |
| Group semantic edits | Groups view controls | `scryer.group.add/set/update/delete` via renderer or IPC | Writes `.scryer/planned.scry` groups | Group card/member UI updates; visible delete removes the group | covered | Pointer member drag, operation-backed nesting setup, and visible `group.delete` are covered by live e2e. |
| View-only no-write workflows | Theme, zoom, tree navigation, mode switching | Renderer/local state or non-semantic view state | Before/after `.scryer/model.scry` and `.scryer/planned.scry` snapshot is unchanged | UI controls are visible and responsive | covered | Evidence: `architecture-human-checklist.spec.ts` "keeps view-only controls from writing Scryer model truth". |
| MCP/tooling compatibility shim | `callTool` public IPC/API and MCP config button | Compatibility handlers call strict catalog operations where implemented; unsupported flow/node aliases are rejected | Strict updates write planned state; config writes `.mcp.json` and Codex config | MCP config visible button, `get_task`, and strict alias matrix pass | covered | Matrix covers strict `delete_edges`, `set_groups`, `delete_group`, and rejected `add_nodes`, `set_node`, `set_flows`, `delete_flow`. |

## Operation Coverage Reality

| Operation group | Operation ids | Status | Notes |
| --- | --- | --- | --- |
| Read/view | `scryer.model.read` | covered | Default renderer reads and prompt reads cross `readView(...)`. |
| Validation | `scryer.model.validate` | covered | Engine validation and MCP `validate_model` tests cover warnings/errors; no separate visible UI validation command is required today. |
| Plan | `scryer.plan.pending`, `scryer.plan.fold` | covered | Engine fold/pending tests plus sync completion gate cover the release path. |
| Node/link edits | `scryer.node.update`, `scryer.node.delete`, `scryer.link.add`, `scryer.link.update`, `scryer.link.delete` | covered | Live visible controls and engine state effects exist. |
| Source edits | `scryer.source.update` | covered | Source-map rows and source links are covered by live tests. |
| Group edits | `scryer.group.add`, `scryer.group.set`, `scryer.group.update` | covered | Visible group add/update/member edits are covered. |
| Group delete | `scryer.group.delete` | covered | Live groups e2e selects a real group, clicks visible delete, and asserts `.scryer/planned.scry` removal. |
| Intent add family | `scryer.system.add`, `scryer.container.add`, `scryer.component.add`, `scryer.group.add`, `scryer.symbol.add` | covered | Product-visible system/container/component/group/code-level flows exist. |
| Less-visible intent add | `scryer.person.add` | covered | Focused IPC/API test asserts planned node creation and renderer notification. |
| Model replacement | `scryer.model.set` | covered | IPC/e2e strict model set rejects invalid fields and writes model state. |
| Drift | `scryer.drift.get`, `scryer.drift.reconcile` | covered | Live drift report/dismiss and IPC seam tests exist. |
| Catalog-only pending parity | `scryer.model.search`, `scryer.model.query`, `scryer.rules.read`, `scryer.codebase.read`, `scryer.model.health`, `scryer.node.set-subtree`, `scryer.node.move`, `scryer.responsibility.move`, `scryer.container.fill`, `scryer.node.descope`, `scryer.drift.flag` | gap | These are catalog rows but still route to `unimplemented(...)`; they belong to #31-#35, not #30 pass criteria. |

## Compatibility Shim Matrix

| Tool/API shape | Status | Evidence or blocker |
| --- | --- | --- |
| `get_model`, `get_node`, `get_task`, `get_changes`, `get_structure`, `get_rules`, `validate_model` | covered | MCP tests cover task ordering, structure, rules, validation and change summaries. |
| `set_model`, `update_nodes`, `delete_nodes`, `add_edges`, `update_edges`, `update_source_map` | covered | MCP tests cover strict planned writes and cleanup. |
| `delete_edges`, strict `set_groups`, strict `delete_group` | covered | Strict MCP matrix test asserts planned-state file effects. |
| `add_nodes`, `set_node`, `set_flows`, `delete_flow` on strict Scryer 0.3 | covered | Strict MCP matrix test asserts these aliases are rejected and cannot revive legacy fields. |
| MCP config write | covered | Live e2e clicks config button and asserts `.mcp.json` plus Codex config content. |

## Out Of Scope For This Audit

- Full parity for the 11 catalog-only operations listed above.
- Scryer Tauri shell, Scryer MCP server product packaging, provider/settings UI,
  docs/templates marketplace, and Rust sidecar runtime.
- Automatic pre-0.3 runtime migration as a normal product path.
- Pixel-perfect `bubblesets-js` visual parity.
- Non-Architecture Orca runtime behavior except where it affects Architecture tab
  lifecycle, session persistence, or sync.

## Conclusion

The migrated Architecture slice has a real frontend/backend spine for the stable
default-model product path: visible controls reach preload/IPC, catalog
operations write engine-owned `.scryer` state, `readView(...)` feeds the
renderer-facing `ArchitectureViewDto`, and live Electron tests inspect visible
UI plus file effects. The stricter #36 gate is closed for the current
release-critical Architecture slice.

This does not mean full Scryer operation parity is complete. The catalog-only
operations listed above remain #31-#35 work, and non-default model manager UX is
outside the current Architecture 0.3 release gate unless a later product
decision promotes it to release-critical.
