-- New table, not another tenant.user_profiles column (unlike onboarding
-- state) — star-nag state is 8 columns of its own concern (dismissal/
-- cooldown/threshold/completion/active-prompt), not a single JSON blob
-- fitting the "one more per-user setting" shape onboarding_state_json used.
-- See specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md
-- for the full design (STAR_NAG_INITIAL_THRESHOLD=35 ported from the old
-- TS backend's backend/src/shared/constants.ts:124).
CREATE TABLE tenant.star_nag_state (
  user_id                          UUID PRIMARY KEY,          -- logical FK -> auth.users, 1:1 like user_profiles.user_id
  company_id                       UUID NOT NULL REFERENCES tenant.companies(id),
  baseline_agents                  BIGINT,
  app_version                      TEXT,
  next_threshold                   BIGINT NOT NULL DEFAULT 35,
  completed                        BOOLEAN NOT NULL DEFAULT false,
  deferred_until                   TIMESTAMPTZ,
  agent_value_moment_app_version   TEXT,
  -- ActiveStarNagPrompt (domain/star_nag_state.go) as JSON, or NULL when no
  -- prompt is currently displayed — replaces the old TS backend's
  -- in-memory-only promptSession (service.ts:66) since a dismiss/later/
  -- openWeb/starOrca call may land on a different tenant-service replica
  -- than the one that served the show.
  active_prompt                    JSONB,
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_star_nag_state_company ON tenant.star_nag_state(company_id);
