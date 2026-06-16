---
name: task-provider-type-contract
description: How issue-tracker provider types (jira/linear/asana) mirror each other across the shared/preload/store/IPC boundary in Orca
metadata:
  type: project
---

Orca's Tasks surface supports multiple issue-tracker providers via a `TaskProvider`
union (`github | gitlab | linear | jira | asana`) in `src/shared/task-providers.ts`.
New providers are expected to mirror the established Jira/Linear type contract.

**Why:** the shared Tasks UI and store slices branch on provider but share a
structural contract, so a new provider's types must line up field-for-field with
the precedent or the abstraction leaks.

**How to apply when reviewing a new provider's types:**
- Provider domain types live in a dedicated `src/shared/<provider>-types.ts`
  (e.g. `jira-types.ts`, `asana-types.ts`), re-exported from `src/shared/types.ts`.
- The multi-tenant selection type follows `string | 'all'` (Jira `JiraSiteSelection`,
  Asana `AsanaWorkspaceSelection`). The `'all'` variant only appears on list/search/
  select/listProjects signatures — single-entity ops (getTask, updateTask, comments)
  intentionally take plain `string`. This split is faithful to Jira, not a bug.
- `<Provider>ConnectionStatus` mirrors Jira: `{ connected: boolean; viewer: V | null;
  ...optional collections }`. The `connected:true`+`viewer:null` representable state
  is tolerated across all providers (not an Asana-specific defect).
- IPC boundary is validated twice: main `ipcMain.handle` path does hand-rolled
  `typeof` guards (`src/main/ipc/<provider>.ts`), runtime RPC path uses Zod schemas
  (`src/main/runtime/rpc/methods/<provider>.ts`). Renderer `runtime-<provider>-client.ts`
  picks the path by runtime target. `callRuntimeRpc<T>` is an unchecked generic
  assertion — shared by all providers, so don't flag it per-provider.
- AGENTS.md rule: provider types must be `.ts`, never `.d.ts` (CI enforces for
  `src/preload/` and `src/shared/`). Asana PR #4881 complied.
