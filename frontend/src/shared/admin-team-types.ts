// ─── Admin Team Types ────────────────────────────────────────────────────
// Backs the Admin Console's Teams tab. CR-RBAC-001 pivoted away from a
// dedicated admin.*Team* channel group (a standalone channels_admin_teams.go
// was drafted, then discarded as a full duplicate of the 5 already-admin-
// gated team.* channels in channels_team.go — see that file's doc comment).
// The frontend still exposes these under window.api.admin.* (this file's
// consumer, admin-org-console-teams-tab.tsx, lives in the Admin Console),
// it just bridges to the team.* wire channels instead of admin.*Team*.
//
// IMPORTANT — shape mismatch vs. every other admin.* type in this
// directory: channels_team.go returns tenant-service's Team/TeamMember
// proto messages UNCONVERTED (`return resp.GetTeams(), nil`, no view-struct
// layer like policyView/sessionView/auditEntryView have). encoding/json
// serializes those using protoc-gen-go's default struct tags, which are
// snake_case (`json:"company_id,omitempty"`), not this codebase's usual
// camelCase convention — confirmed by reading tenant.pb.go's generated
// struct tags directly, not assumed. Field names below match that wire
// shape exactly.
//
// TeamMember has NO `role` field (tenant.proto's message TeamMember only
// declares user_id/priority) — do not add one; role model stays
// developer|admin per FE-TASK-001, unrelated to team membership.
export type AdminTeam = {
  id: string
  company_id: string
  name: string
  settings_json: string
}

export type AdminTeamMember = {
  user_id: string
  priority: number
}
