# backend-go Tasks — Automations (v4)

**Solutions:** [../solutions/](../solutions/README.md)

## Track 1 — Xác nhận routing (BE-AUTO-SOL-001)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-AUTO-001](./TASK-BE-AUTO-001-confirm-routing-and-document.md) — verify `workflow-service` không chặn remote target + ghi kiến trúc 2 trục vào README | Không | ✅ DONE |

## Track 2 — Action chain data model (BE-AUTO-SOL-002)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-AUTO-002](./TASK-BE-AUTO-002-proto-action-chain.md) — proto `AutomationAction`/`actions`/`ActionResult` | 001 (khuyến nghị, không cứng) | ✅ DONE |
| [TASK-BE-AUTO-003](./TASK-BE-AUTO-003-postgres-migration-action-chain.md) — Postgres migration `0003` | 002 | ✅ DONE |
| [TASK-BE-AUTO-004](./TASK-BE-AUTO-004-execute-automation-chain-usecase.md) — `execute_automation_chain.go` + legacy mapping | 002, 003 | ✅ DONE — `RunNow` rewired thật (pass 2, 2026-09-09), `create_pr` cũng wire luôn qua `scm-integration-service` |

## Track 3 — Executor `commit_push`/`create_pr` (BE-AUTO-SOL-003)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-AUTO-005](./TASK-BE-AUTO-005-git-commit-push-executor.md) — `StepTypeCommitPush` + `GitCommitPushExecutor` | 004 | ✅ DONE |
| [TASK-BE-AUTO-006](./TASK-BE-AUTO-006-create-pr-dispatch.md) — `create_pr` dispatch branch + `scm-integration-service` client | 004 | ✅ DONE |

## Track 4 — Executor `run_script`/`send_notification` (BE-AUTO-SOL-004)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-AUTO-007](./TASK-BE-AUTO-007-run-script-notification-mapping.md) — mapping trong `dispatch()` | 004, [TASK-AG-AUTO-001](../../../../agent/crs/v4/automation/tasks/TASK-AG-AUTO-001-verify-shell-notification-contract.md) | ✅ DONE |

## Track 5 — Event trigger thật (BE-AUTO-SOL-005)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-AUTO-008](./TASK-BE-AUTO-008-external-trigger-auth.md) — auth interceptor `HandleExternalTrigger` | 001 | ✅ DONE — phạm vi thu hẹp thật, xem task's "Kết quả thực tế" |
| [TASK-BE-AUTO-009](./TASK-BE-AUTO-009-pr-merged-source-and-circular-guard.md) — nối nguồn PR-merged + circular-trigger guard | 008 | ⛔ BLOCKED — scope lớn hơn 1 task, cần quyết định sản phẩm |

## Track 6 — Retention/timeout/concurrency (BE-AUTO-SOL-006)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-AUTO-010](./TASK-BE-AUTO-010-retention-and-timeout.md) — `max_run_history` + prune + `run_timeout_seconds` | 003 (schema, gộp migration nếu gần nhau) | ✅ DONE |
| [TASK-BE-AUTO-011](./TASK-BE-AUTO-011-concurrency-guard.md) — `running_run_id` concurrency guard | 003, 010 | ✅ DONE |

## Track 7 — REST parity + fix README (BE-AUTO-SOL-007)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-AUTO-012](./TASK-BE-AUTO-012-rest-parity-and-readme-fix.md) — REST route List/Update/Delete/Get + sửa README | Không | ✅ DONE |

## Thứ tự thực thi

```
001 → 002 → 003 → 004 → { 005, 006 } (song song) → 007 (chờ TASK-AG-AUTO-001)
001 → 008 → 009
003 → 010 → 011
012 → độc lập hoàn toàn, làm bất cứ lúc nào
```

**Lưu ý migration**: TASK-BE-AUTO-003 (actions/action_results) và
TASK-BE-AUTO-010/011 (retention/concurrency columns) đều ALTER
`automations`/`automation_runs` — nếu implement gần nhau về thời gian,
**gộp thành 1 file migration** thay vì 2-3 file rời, tránh xung đột thứ
tự migration.

## Nguyên tắc chung cho AI thực thi các task này

- **Luôn chạy `impact()`/`codegraph explore` trước khi sửa symbol** —
  đặc biệt `run_now.go` (Track 2 thay thế 1 phần logic của nó) và
  `Automation`/`AutomationRun` proto message (dùng ở khắp usecase layer).
- **`tenantID`/`userID` luôn từ `tenant.RequireTenantID(ctx)`** — không
  bao giờ từ request field client gửi (xem solutions/README.md's
  "Nguyên tắc bảo mật xuyên suốt").
- **Không đổi field proto cũ, chỉ thêm field mới** — automation cũ
  (`step_type`/`step_config_json`) phải tiếp tục đọc được sau mọi task
  trong Track 2.
- **Test trước, không giả định pass.**
