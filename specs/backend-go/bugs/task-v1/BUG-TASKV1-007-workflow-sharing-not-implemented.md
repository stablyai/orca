# BUG-TASKV1-007: Workflow template scope is still `company|team|personal` only — no public visibility, no share token, no fork/clone

**Business Logic:** [BL-WF-01](../../../../docs/logic/workflow-orchestration/BL-WF-01-workflow-template.md), [BL-WF-03](../../../../docs/logic/workflow-orchestration/BL-WF-03-workflow-sharing.md) — Workflow Template Management, Workflow Sharing & Library Discovery
**Service:** `workflow-service`
**File:** `backend-go/services/workflow-service/internal/domain/template.go`
**Priority:** P1
**Status:** NOT_IMPLEMENTED
**Severity:** High
**Symptom:** `workflow.templates` still has no `visibility`, `owner_id`, `share_token`, `rating`, or `usage_count` column — `Scope` is a closed 3-value enum (`company`/`team`/`personal`), confirmed unchanged. There is still no way to publish a template publicly, generate a share link, fork/clone someone else's template, search the library by text/tags, or see usage/rating stats.

---

## Spec summary

BL-WF-01/BL-WF-03 together describe: `name/description/tags/scope/visibility` at creation, two inheritance modes (Clone = disconnected copy, Inherit = live parent reference with `overrides`/`inject_steps`/`remove_steps`), visibility escalation (private → team → company → public) with admin approval for company-scope publishing, public share-link generation + token-based read-only preview + one-click import, full-text/tag library search with trending/recent sort, 1-5 star rating, and usage-count tracking.

## What backend-go has (confirmed current)

- `Scope` (`backend-go/services/workflow-service/internal/domain/template.go:10-21`) is confirmed still exactly `ScopeCompany`/`ScopeTeam`/`ScopePersonal` — a 3-value closed enum, `Valid()` rejects anything else. No `public` value, no separate `visibility` concept distinct from `scope`.
- `NewWorkflowTemplate` (`template.go:84-113`, per the original audit) still validates only tenant/name/scope and self-parent rejection — confirmed no new validation for description/tags/visibility has been added, since those fields don't exist on the struct to validate.
- Parent-chain inheritance (`parent_template_id` + `ResolveChain` recursive CTE) and version-bump-on-every-update remain real and unchanged.

## What's missing (re-confirmed, unchanged since prior audit)

- No `owner_id`, `description`, `tags`, or `visibility` columns anywhere on `workflow.templates` — confirmed by the current `Scope`-only enum above; the entire Publish & Share flow (private→team→company→public, share-link, admin approval) has no data model to sit on.
- No Clone mode — only the Inherit shape (`parent_template_id` reference) exists; no disconnected-copy creation path.
- `resolveTemplate()` still does an all-or-nothing "nearest ancestor with any steps wins" swap, not the spec's field-level `overrides`/`inject_steps`/`remove_steps` deep-merge.
- No rating or `usage_count` tracking — no column, no increment-on-run usecase, no rating RPC.
- No admin-approval workflow for company-scope publishing.
- No public share-link generation, no token-based anonymous preview, no "Import to My Workflows" flow.
- No library text/tag search or trending/recent sort — `ListTemplates` still filters by `scope` only.

## See also

- [`logic-v1/BUG-WF-01-workflow-template-sharing-fields-missing.md`](../logic-v1/BUG-WF-01-workflow-template-sharing-fields-missing.md) — full original audit of the missing schema fields and inheritance-merge gap, complete citations.
- [`logic-v1/BUG-WF-03-workflow-sharing-not-implemented.md`](../logic-v1/BUG-WF-03-workflow-sharing-not-implemented.md) — full original audit of the sharing/library/rating gap, complete citations. This report only re-confirms both are unchanged; it does not restate their content.
- [`logic-v1/solutions/SOL-WF-01-template-authoring-fields.md`](../logic-v1/solutions/SOL-WF-01-template-authoring-fields.md), [`SOL-WF-03-workflow-sharing-library.md`](../logic-v1/solutions/SOL-WF-03-workflow-sharing-library.md) — proposed designs for both gaps.

## References

- `backend-go/services/workflow-service/internal/domain/template.go:5-21,84-113` — `Scope` enum (3 values, confirmed unchanged), `NewWorkflowTemplate`
- `backend-go/proto/orca/workflow/v1/workflow.proto:59-66` — `WorkflowTemplate` message, no owner_id/description/tags/visibility fields
- `backend-go/services/workflow-service/internal/usecase/list_templates.go` — scope-filter-only listing, no text/tag search or sort
