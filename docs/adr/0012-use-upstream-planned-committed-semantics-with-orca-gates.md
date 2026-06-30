# Use upstream planned/committed semantics with Orca gates

Orca preserves upstream planned/committed semantics: draft edits write planned state, while folds, extraction, corrections, and drift verdicts explicitly affect committed state. Orca adds Model Edit Lease and Completion Gate enforcement so agent completion and UI write-back cannot silently corrupt the model.

Model Edit Lease tokens are write-concurrency credentials held in trusted main-process context. They may be attached to `ScryerOperationContext` by the edit-session controller, but renderer-facing DTOs, logs, prompts, and generic operation inputs must expose only sanitized lease status, never the raw token.
