# Frontend Tasks — Storage Consolidation

**Solutions:** [../solutions/](../solutions/README.md)

## Track 1 — `tenant-service` (preference cá nhân)

| Task | Solution | Depends on | Status |
|---|---|---|---|
| [FE-TASK-STORAGE-001](./FE-TASK-STORAGE-001-runtime-client-state-client.md) — shared RPC wrapper | FE-SOL-STORAGE-001 | TASK-BE-STORAGE-004 | ✅ DONE |
| [FE-TASK-STORAGE-002](./FE-TASK-STORAGE-002-keybindings-hybrid-remote.md) — keybindings hybrid + seed | FE-SOL-STORAGE-001 | 001 | ✅ DONE |
| [FE-TASK-STORAGE-003](./FE-TASK-STORAGE-003-ui-local-and-runtime-status-sync.md) — ui-local + saved-server-list | FE-SOL-STORAGE-001 | 001 | ✅ DONE |
| [FE-TASK-STORAGE-004](./FE-TASK-STORAGE-004-backend-go-storage-adapter.md) — `StateStorage` adapter + `persistence-status.ts` | FE-SOL-STORAGE-002 | 001 | ✅ DONE |
| [FE-TASK-STORAGE-005](./FE-TASK-STORAGE-005-wire-persist-middleware.md) — bọc `persist` vào keybindings/settings | FE-SOL-STORAGE-002 | 004, 002, 006/007 | ✅ DONE (2026-09-08) — keybindings.ts + banner + settings.ts (qua `web-preload-api.ts`, không dùng `persist` HOC, xem task doc) |
| [FE-TASK-STORAGE-006](./FE-TASK-STORAGE-006-web-preload-full-settings-sync.md) — full `GlobalSettings` sync | FE-SOL-STORAGE-003 | TASK-BE-STORAGE-004, 001 | ✅ DONE — ⚠️ `stripSecretFields` là mitigation tạm thời, security review sign-off thật vẫn còn cần |
| [FE-TASK-STORAGE-007](./FE-TASK-STORAGE-007-full-settings-seed.md) — seed dữ liệu cũ | FE-SOL-STORAGE-003 | 006 | ✅ DONE |
| [FE-TASK-STORAGE-008](./FE-TASK-STORAGE-008-workspace-session-remote-sync.md) — workspaceSession debounce+RPC | FE-SOL-STORAGE-004 | TASK-BE-STORAGE-004 | ✅ DONE |
| [FE-TASK-STORAGE-009](./FE-TASK-STORAGE-009-accounts-dev-server-remote-map.md) — accountsDevServer RPC map | FE-SOL-STORAGE-004 | TASK-BE-STORAGE-004 | ✅ DONE |
| [FE-TASK-STORAGE-010](./FE-TASK-STORAGE-010-remove-bug-fe-pty-001-diagnostic.md) — xoá diagnostic PTY-001 | FE-SOL-STORAGE-005 | Không | ✅ DONE |
| [FE-TASK-STORAGE-011](./FE-TASK-STORAGE-011-remove-remove-project-diagnostic.md) — xoá diagnostic Remove Project | FE-SOL-STORAGE-005 | Không | ✅ DONE — bug đã được xác nhận đóng, module + 5 call site đã xoá, 28/28 test pass |

## Track 2 — `infra-fleet-service`/`orchestration-service` (dev-server/agent)

| Task | Solution | Depends on | Status |
|---|---|---|---|
| [FE-TASK-STORAGE-012](./FE-TASK-STORAGE-012-hydrate-dev-servers-and-agent-sessions.md) — hydrate dev-servers + agent-sessions | FE-SOL-STORAGE-006 | TASK-BE-STORAGE-005, 008 | 🟡 PARTIAL — dev-servers.ts hydrate ✅ DONE; backend RPC now ✅ DONE too, but remote-agent-sessions.ts hydrate 🔲 BLOCKED on a narrower new gap (assigneeHandle↔worktreeId linkage, see BACKLOG-013) |
| [FE-TASK-STORAGE-013](./FE-TASK-STORAGE-013-hydrate-bootstrap-ssh-provisioning.md) — hydrate bootstrap/ssh/provisioning | FE-SOL-STORAGE-006 | TASK-BE-STORAGE-005 | 🟡 PARTIAL — ssh/provisioning/runtime-environment-ssh ✅ DONE, bootstrap.ts 🔲 BLOCKED (no `bootstrap_status` proto field) |
| [FE-TASK-STORAGE-014](./FE-TASK-STORAGE-014-connectivity-status-slice-and-poll.md) — connectivity-status slice + poll | FE-SOL-STORAGE-006 | TASK-BE-STORAGE-008, 004 | ✅ DONE |
| [FE-TASK-STORAGE-015](./FE-TASK-STORAGE-015-auth-failure-no-clear.md) — auth-failure không `.clear()` | FE-SOL-STORAGE-007 | Không | ✅ DONE |
| [FE-TASK-STORAGE-016](./FE-TASK-STORAGE-016-logout-confirm-and-teardown.md) — logout confirm + teardown | FE-SOL-STORAGE-007 | 014; backend TASK-BE-STORAGE-012 | ✅ DONE (2026-09-08) — useLogout.ts confirm + closeAllActiveSessions() (7/7 tests), `connection.teardown` wscompat channel now wired end-to-end by `TASK-BE-STORAGE-012` Part C/D, re-verified after |

## Thứ tự thực thi

```
Track 1:
  001 → 002 ┐
       → 003 ┤
  004 (song song với 001-003) → 005 (cần 002 VÀ 006/007 xong)
  006 → 007
  008 (độc lập, chỉ cần backend-go xong)
  009 (độc lập, chỉ cần backend-go xong)
  010 (độc lập, làm ngay)
  011 (độc lập, làm ngay — nếu điều kiện tiên quyết thoả)

Track 2:
  012 ┐
  013 ├→ (không phụ thuộc lẫn nhau, có thể song song)
  014 ┘
  015 (độc lập, làm ngay)
  016 (phụ thuộc 014 cho danh sách connection; phần teardown thật cần backend TASK-BE-STORAGE-012 xong)
```

2 track độc lập nhau, có thể chạy song song hoàn toàn.

## Nguyên tắc chung cho AI thực thi các task này

- **Luôn chạy `impact()`/`codegraph explore` trước khi sửa symbol** — mỗi
  task đã ghi symbol cần kiểm tra ở mục "gitnexus", đây là yêu cầu bắt buộc
  chung theo `CLAUDE.md`/`AGENTS.md`.
- **Không đổi hành vi desktop hiện có** — mọi task trong Track 1 chỉ thêm
  nhánh `target.kind === 'environment'`, nhánh desktop-local giữ nguyên.
- **Task có điều kiện tiên quyết (006, 010, 011) — dừng lại và báo cáo nếu
  điều kiện không thoả**, không tự ý bỏ qua điều kiện để "cứ làm cho xong".
- **Test trước, không giả định pass** — mọi lệnh `vitest run` trong mục
  "Verify" phải thực sự chạy và thấy kết quả.
- **Không tự thêm RPC/wscompat channel mới ngoài thiết kế** — nếu 1 task
  phát hiện thiếu RPC (ví dụ FE-TASK-STORAGE-016's `connection.teardown`),
  báo cáo lại cho phía backend-go, không tự chế 1 cơ chế khác để né việc
  thiếu RPC.
