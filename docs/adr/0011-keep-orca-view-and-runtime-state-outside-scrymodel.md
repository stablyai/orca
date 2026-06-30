# Keep Orca view and runtime state outside ScryModel

`ScryModel` stores architecture truth only. Orca selection, expanded paths, active tabs, layout/render cache, retained flow-editor data, agent progress, and model edit leases live in Orca-owned state so UI mechanics do not pollute the agent-facing model.

Only sanitized model-edit lease status is renderer-facing. The raw lease token stays in trusted main-process/edit-session context and must not be persisted into `ScryModel`, renderer store state, DOM state, logs, or prompts.
