---
name: tracker-error-contract
description: The shared error-surfacing contract for issue-tracker providers (Asana, Jira, Linear) in this Electron app — what is intentionally swallowed vs surfaced, and where Asana diverges.
metadata:
  type: project
---

Issue-tracker providers (`src/main/{asana,jira,linear}/`) share a deliberate, intentional error-handling contract. When reviewing a new provider, compare against this baseline before flagging — most "swallows" here are established and consistent, not new silent failures.

**The established contract (all three providers):**
- Main-process list/search/metadata ops use a `fanOut` helper: auth errors (401/403) → `clearToken` + rethrow when a single workspace/site is selected, swallow + return `[]` when selection is `'all'`. Non-auth errors → `console.warn('[provider] <op> failed:', error)` + return `[]`. Gated by `shouldThrowAuthError(selection) = selection !== 'all'`.
- Mutations (create/update/comment) return `{ ok: false, error }`; auth errors rethrow after `clearToken`. UI shows these via `toast.error`.
- Renderer store slices (`src/renderer/src/store/slices/<provider>.ts`) catch list/search errors with `console.warn` + return `[]` (NO toast — empty list is the UX), and flip status to disconnected on `looksLikeAuthError` (regex on message). This is intentional and identical across providers.
- Token storage: `safeStorage` with plaintext fallback + `console.warn('... storing token in plaintext')`. `readToken` decrypt failure → `catch { return null }` (silent; workspace then yields no client → empty results). This decrypt-silent-null is pre-existing across ALL providers — do not flag as Asana-specific.

**Where Asana DIVERGES (the only PR-specific risk surface):**
- `searchTasks` (`src/main/asana/issues.ts`) has a local-filter fallback NOT present in Jira/Linear: when the premium `/tasks/search` endpoint throws any `AsanaApiError` with status !== 401/403, it silently falls back to `fetchTasksForClient(entry, 'all', 100)` + client-side `title.includes()` filter. The comment justifies this for 402 (free tier), but the condition catches ALL non-auth statuses (429/500/400), so transient/server errors are masked as degraded partial results with no log on the success path and no signal to the UI. Auth errors are correctly NOT masked (rethrown). Network errors (fetch TypeError, not AsanaApiError) are also not masked.

**How to apply:** For tracker PRs, focus silent-failure review on provider-SPECIFIC divergences from this contract (like the Asana search fallback's over-broad status condition), not the shared fan-out/store-slice swallowing, which is deliberate and consistent.
