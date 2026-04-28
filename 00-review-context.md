# Review Context

## Branch Info

- Base: origin/main
- Current: brennanb2025/pr-agent-hook-endpoint-discovery
- Merge base: 3fe716263447feba560bdbb2a2757c15cf13ba44

## Changed Files Summary

- M docs/design/agent-hook-endpoint-discovery.md
- M src/main/agent-hooks/server.test.ts
- M src/main/agent-hooks/server.ts
- M src/main/claude/hook-service.ts
- M src/main/codex/hook-service.ts
- M src/main/cursor/hook-service.ts
- M src/main/gemini/hook-service.ts
- M src/main/index.ts
- M src/main/opencode/hook-service.test.ts
- M src/main/opencode/hook-service.ts
- M src/shared/agent-hook-types.ts

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File                                        | Changed Lines                                                     |
| ------------------------------------------- | ----------------------------------------------------------------- |
| docs/design/agent-hook-endpoint-discovery.md | 1-269 (new file)                                                 |
| src/main/agent-hooks/server.test.ts         | 3-4, 833-981                                                      |
| src/main/agent-hooks/server.ts              | 4-14, 1051-1059, 1069-1075, 1093, 1101-1104, 1186-1190, 1205-1213, 1241-1247, 1253-1314 |
| src/main/claude/hook-service.ts             | 59-65, 77-84                                                      |
| src/main/codex/hook-service.ts              | 50-54, 66-71                                                      |
| src/main/cursor/hook-service.ts             | 62-66, 78-83                                                      |
| src/main/gemini/hook-service.ts             | 52-56, 72-77                                                      |
| src/main/index.ts                           | 427-428, 434-441                                                  |
| src/main/opencode/hook-service.test.ts      | 37-73                                                             |
| src/main/opencode/hook-service.ts           | 47-95, 147-151, 153-154, 159-160, 168                             |
| src/shared/agent-hook-types.ts              | 23-29                                                             |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main
- src/main/agent-hooks/server.test.ts
- src/main/agent-hooks/server.ts
- src/main/claude/hook-service.ts
- src/main/codex/hook-service.ts
- src/main/cursor/hook-service.ts
- src/main/gemini/hook-service.ts
- src/main/index.ts
- src/main/opencode/hook-service.test.ts
- src/main/opencode/hook-service.ts

### Utility/Common
- src/shared/agent-hook-types.ts
- docs/design/agent-hook-endpoint-discovery.md

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

(none yet)

## Iteration State

Current iteration: 1
Last completed phase: Setup
Files fixed this iteration: []
