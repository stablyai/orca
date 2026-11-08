/** Fold these columns into frozen001; the separate application exists only in the focused test. */
export const JOURNAL_DOMAIN_SUBMISSION_COLUMNS = `
admission_body_json TEXT,
admission_provider_handle_json TEXT,
admission_fence INTEGER NOT NULL DEFAULT 0,
admission_scope_json TEXT,
admission_family_id TEXT,
admission_origin TEXT,
admission_source_kind TEXT,
admission_options_json TEXT,
dispatch_fence INTEGER NOT NULL DEFAULT 0,
signed_out INTEGER NOT NULL DEFAULT 0 CHECK(signed_out IN (0,1)),
handover_sequence INTEGER,
handover_at INTEGER,
handover_fence INTEGER,
handover_scope_json TEXT,
handover_place_sequence INTEGER,
handover_place_at INTEGER,
handover_place_scope_json TEXT,
carries_json TEXT,
rejection_sequence INTEGER,
rejection_at INTEGER,
rejection_fence INTEGER,
rejection_reason TEXT,
rejection_fact_json TEXT,
rejection_recovered INTEGER,
rejection_kept_message_id TEXT,
rejection_answered_turn_json TEXT,
presentation_member INTEGER NOT NULL DEFAULT 0 CHECK(presentation_member IN (0,1)),
normalized_handoff INTEGER NOT NULL DEFAULT 0 CHECK(normalized_handoff IN (0,1))
`

export const JOURNAL_DOMAIN_SUBMISSION_INDEXES = `
CREATE INDEX journal_submission_family ON journal_submission_attempts(
  session_id,epoch,admission_family_id,attempt_sequence,attempt_index,ordinal) WHERE current=1;
CREATE INDEX journal_submission_ordinal ON journal_submission_attempts(session_id,epoch,ordinal);
CREATE INDEX journal_submission_signed_out ON journal_submission_attempts(session_id,epoch,dispatch_fence)
  WHERE current=1 AND signed_out=1;
`
