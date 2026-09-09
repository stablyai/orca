// ─── Admin Access Policy Types ──────────────────────────────────────────────
// Backs the Admin Console's Policies tab — mirrors the `policyView` shape
// api-gateway's channels_admin_policies.go returns for admin.listPolicies /
// getPolicy / createPolicy / updatePolicy / deletePolicy (a converted view
// struct with camelCase json tags, not a raw proto passthrough — see
// admin-team-types.ts for the contrasting raw-proto case). Pure type file —
// no imports from other project modules.
//
// CR-RBAC-006 (OPA bundle publish) has not landed yet as of this file's
// authoring — editing a policy through these RPCs persists it but has no
// real enforcement effect until that publish pipeline is wired live. The
// Policies tab UI surfaces this as a banner (see
// admin-org-console-policies-tab.tsx).

export type AdminAccessPolicy = {
  id: string
  name: string
  kind: string
  documentJson: string
  version: number
  updatedBy: string
  updatedAtUnixMs: number
}
