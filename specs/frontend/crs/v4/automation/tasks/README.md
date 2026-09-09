# frontend Tasks — Automations (v4)

**Solutions:** [../solutions/](../solutions/README.md)

## Track 1 — Xác nhận routing (FE-AUTO-SOL-001)

| Task | Depends on | Status |
|---|---|---|
| [FE-TASK-AUTO-001](./FE-TASK-AUTO-001-running-on-badge.md) — badge "chạy ở đâu" | Không | ✅ DONE (2026-09-09) — list row xong, xem task doc |

## Track 2 — Action chain type plumbing (FE-AUTO-SOL-002)

| Task | Depends on | Status |
|---|---|---|
| [FE-TASK-AUTO-002](./FE-TASK-AUTO-002-actions-type-plumbing.md) — `AutomationAction` type + host-client pass-through | [TASK-BE-AUTO-002](../../../../backend-go/crs/v4/automations/tasks/TASK-BE-AUTO-002-proto-action-chain.md) | ✅ DONE — phạm vi mở rộng thật (2 gap thật phát hiện+sửa, 1 gap `connectionId` được ghi lại chưa sửa), xem "Kết quả thực tế" |

## Track 3/4 — Action config UI (FE-AUTO-SOL-003/004)

| Task | Depends on | Status |
|---|---|---|
| [FE-TASK-AUTO-003](./FE-TASK-AUTO-003-action-config-form-commit-pr.md) — `AutomationActionConfigForm` + `commit_push`/`create_pr` fields | 002 | ✅ DONE — `AutomationActionList` chưa nối vào save flow thật (`AutomationsPage.tsx`), xem task's "Kết quả thực tế" Phát hiện 3 |
| [FE-TASK-AUTO-004](./FE-TASK-AUTO-004-action-config-form-script-notification.md) — `run_script`/`send_notification` fields | 003 | ✅ DONE — F11 xác nhận `channel` free-text, env editor tái dùng `agent-default-env-draft.ts` |

## Track 5 — Event trigger thật (FE-AUTO-SOL-005)

| Task | Depends on | Status |
|---|---|---|
| [FE-TASK-AUTO-005](./FE-TASK-AUTO-005-remove-automation-event-bridge.md) — xoá `AutomationEventBridge.ts` dead code | Không | ✅ DONE |
| [FE-TASK-AUTO-006](./FE-TASK-AUTO-006-external-trigger-type-ui.md) — trigger type `external` + picker UI | [TASK-BE-AUTO-008](../../../../backend-go/crs/v4/automations/tasks/TASK-BE-AUTO-008-external-trigger-auth.md) (mềm) | ✅ DONE — chỉ UI/preview, `Automation` chưa có field lưu trigger mode (xem task's "Kết quả thực tế") |
| [FE-TASK-AUTO-007](./FE-TASK-AUTO-007-agent-session-signal-investigation.md) — khảo sát tín hiệu "agent hoàn thành" (không phải task code) | Không | ⛔ BLOCKED — cần xác nhận sản phẩm |

## Track 6 — `WorktreeCleanupService.ts` (FE-AUTO-SOL-006)

| Task | Depends on | Status |
|---|---|---|
| [FE-TASK-AUTO-008](./FE-TASK-AUTO-008-worktree-cleanup-service-decision.md) — khảo sát + wire/xoá | Không | 🟡 PARTIAL |

## Thứ tự thực thi

```
FE-TASK-AUTO-001 → độc lập, làm bất cứ lúc nào
FE-TASK-AUTO-002 → chờ TASK-BE-AUTO-002 (proto) ship — ✅ DONE, nhưng để
                    BẤT KỲ action nào (run_agent/run_script/
                    send_notification/commit_push — mọi StepConfig
                    workflow-service dùng) THẬT SỰ dispatch được (không
                    chỉ gửi đúng shape) còn cần 1 CR/task riêng resolve
                    `connectionId` (infra-fleet-service's connection —
                    khác `repo.connectionId`) từ automation's
                    runContext/executionTargetId — mọi StepConfig
                    (`AgentStepConfig`/`ShellStepConfig`/
                    `NotificationStepConfig`/`CommitPushStepConfig`) đều
                    bắt buộc field này, xác nhận qua đọc
                    `workflow-service/internal/domain/step.go` trực tiếp.
                    Chỉ `create_pr` (dispatch qua scm-integration-service,
                    không qua workflow-service) không cần. Xem
                    FE-TASK-AUTO-002's "Kết quả thực tế", Phát hiện 3.
                    FE-TASK-AUTO-003/004 (UI cho action's `config` field)
                    không bị BLOCK bởi gap này — chỉ cần biết: action tạo
                    ra qua UI đó sẽ không dispatch thành công cho tới khi
                    gap connectionId được giải quyết riêng.
FE-TASK-AUTO-003 → 002
FE-TASK-AUTO-004 → 003
FE-TASK-AUTO-005 → độc lập, làm sớm (dọn dead code không rủi ro)
FE-TASK-AUTO-006 → độc lập kỹ thuật, nhưng nên đợi TASK-BE-AUTO-008 auth
                    xong trước khi expose UI cho external trigger
FE-TASK-AUTO-007 → BLOCKED, không tự thực thi — chỉ ghi khảo sát, chờ
                    quyết định sản phẩm chung với CR-EVM-010
FE-TASK-AUTO-008 → độc lập, làm bất cứ lúc nào
```

## Nguyên tắc chung cho AI thực thi các task này

- **Luôn chạy `impact()`/`codegraph explore` trước khi sửa symbol.**
- **`AutomationsPage.tsx` đã 2991 dòng** (đính chính 2026-09-09: dòng số
  này thuộc `AutomationsPage.tsx`, KHÔNG phải `AutomationEditorDialog.tsx`
  — file đó đã tách sẵn thành ~208 dòng qua
  `AutomationEditorDialogHeader.tsx`/`AutomationEditorPromptSection.tsx`/
  `AutomationEditorDialogFooter.tsx` từ trước FE-TASK-AUTO-003, xác nhận
  thật khi thực thi task đó). Nguyên tắc vẫn giữ nguyên: mọi UI mới
  (FE-TASK-AUTO-003/004) PHẢI tách file riêng, không thêm vào
  `AutomationsPage.tsx` hay bất kỳ file đã lớn nào (AGENTS.md's "Lint
  Rules: Do Not Disable Max Lines" — không xin exception baseline).
- **FE-TASK-AUTO-007 không được tự thực thi mã nguồn** — chỉ ghi báo cáo
  khảo sát, chờ human/product quyết định (khớp CR-AUTO-005's cảnh báo).
- **Test trước, không giả định pass.**
- **Khi chạy nhiều task song song (agent riêng/worktree riêng) rồi merge
  thủ công**: 1 file dùng chung (`automations-types.ts` là ví dụ thật —
  xem FE-TASK-AUTO-006's "Phát hiện thêm khi merge") có thể vượt
  `max-lines` do CỘNG DỒN 2 thay đổi, dù mỗi task riêng lẻ không vượt.
  Luôn chạy `npx oxlint` lại SAU KHI merge, không chỉ tin verify output
  của từng agent chạy riêng lẻ trong worktree cô lập của nó.
