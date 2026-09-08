# Agent Tasks — Storage Consolidation (CR-STORAGE-00x)

**Solutions:** [../solutions/](../solutions/README.md)
**CRs:** [docs/crs/v3/storage/](../../../../../docs/crs/v3/storage/README.md)

9 tasks, broken out from the 3 solution docs so each is independently
executable by an AI coding session with a clear scope, acceptance
criteria, and verification command. Investigation tasks are marked as
such — they produce a decision/finding recorded back into the relevant
solution doc, not application code.

| Task | Solution | Type | Priority | Depends on | Status |
|---|---|---|---|---|---|
| [TASK-AG-STORAGE-001](./TASK-AG-STORAGE-001-audit-globalsettings-credential-fields.md) | SOL-001 | Investigation | 🔴 Critical | — | ✅ Done |
| [TASK-AG-STORAGE-002](./TASK-AG-STORAGE-002-verify-health-reporter-cadence.md) | SOL-002 | Investigation (+ possible small fix) | 🟡 Medium | — | ✅ Done |
| [TASK-AG-STORAGE-003](./TASK-AG-STORAGE-003-clarify-bootstrap-status-ownership.md) | SOL-002 | Investigation (+ possible small impl) | 🟡 Medium | — | ✅ Done |
| [TASK-AG-STORAGE-004](./TASK-AG-STORAGE-004-fix-stale-reconnect-docs.md) | SOL-002 | Docs only | 🟢 Low | — | ✅ Done |
| [TASK-AG-STORAGE-005](./TASK-AG-STORAGE-005-design-decisions-before-implementation.md) | SOL-003 | Investigation/decision | 🔴 Critical | — | ✅ Done |
| [TASK-AG-STORAGE-006](./TASK-AG-STORAGE-006-build-agent-spawn-daemon.md) | SOL-003 | Implementation | 🔴 Critical | 005 | ✅ Done (implemented differently than scoped — see notes) |
| [TASK-AG-STORAGE-007](./TASK-AG-STORAGE-007-rewire-agent-spawner-and-session-stop.md) | SOL-003 | Implementation | 🔴 Critical | 006 | ✅ Done |
| [TASK-AG-STORAGE-008](./TASK-AG-STORAGE-008-align-grace-period-with-backend-go.md) | SOL-003 | Small implementation | 🟡 Medium | 006, cross-repo `BE-SOL-STORAGE-003` | ✅ Done |
| [TASK-AG-STORAGE-009](./TASK-AG-STORAGE-009-desktop-mirror-sync-and-integration-tests.md) | SOL-003 | Implementation + tests | 🟡 Medium | 005, 006, 007 | ✅ Done |

## Kết quả thực thi — 9/9 Done (2026-09-08, cập nhật từ 2026-09-07)

Tất cả 9 task đã Done. 007/008/009 ban đầu (2026-09-07) dừng ở Partial vì
phụ thuộc backend-go chưa xong; khi `TASK-BE-STORAGE-009` (grace period
300s) và `TASK-BE-STORAGE-012` Part C/D (`connection.teardown` wscompat +
agent-notify) hoàn thành ở phiên 2026-09-08, cả 3 được quay lại đóng nốt.
Chi tiết đầy đủ nằm trong từng file task's "Completion Notes"/"Closing
update"; tóm tắt:

- **001–005**: điều tra xong, có bằng chứng cụ thể (file:line/commit), đã
  cập nhật lại `SOL-AG-STORAGE-001/002/003` và sửa 3 chỗ TDD-AG sai
  (`00-index.md`, `03-connection-modes.md`, `04-handshake-session.md`).
- **006/007 (lõi CR-STORAGE-008b)**: **đã sửa thật** trong
  `agent/src/relay/agent-spawner.ts`/`agent-session.ts` — thay hành vi kill
  ngay lập tức (`ORCH-011`) bằng grace-period 120s + rebind kết nối khi
  reconnect, ĐÚNG như pattern đã chứng minh cho terminal PTY, nhưng KHÔNG
  cần tách daemon riêng (khác dự kiến ban đầu — xem TASK-005).
- **007 phần "confirmed logout"**: đóng ngày 2026-09-08 — `connection.teardown`
  (backend-go → agent, qua `DevServerAgentClient.Exec` đã có sẵn) nay có
  handler thật ở `agent-rpc-dispatch-misc.ts`, gọi `cleanupAllPtys` (đã có)
  + `notifyDaemonSessionTeardown` (mới, → daemon's `daemon.sessionTeardown`,
  kill ngay không chờ grace period).
- **008**: đóng ngày 2026-09-08 — `TASK-BE-STORAGE-009` ship
  `grace_period_seconds` mặc định 300s; 120s (agent) ≤ 300s ✓, không cần
  sửa code, chỉ xác nhận lại.
- **009 phần 4 (immediate-kill-on-teardown)**: đóng ngày 2026-09-08 — cover
  ở tầng daemon/dispatch (`pty-daemon-server.test.ts`,
  `agent-rpc-dispatch-misc.test.ts`) thay vì lặp lại trong file integration
  test reconnect.

**Verified cuối cùng (2026-09-08)**: `tsc --noEmit` sạch (0 lỗi mới so với
baseline), `vitest run` toàn bộ `agent/` xanh: **3909 passed, 10 skipped, 0
failed** (tăng từ 3904 — 5 test mới: 1 ở `pty-daemon-server.test.ts`, 2 ở
`pty-daemon-client.test.ts`, 2 ở `agent-rpc-dispatch-misc.test.ts` — file
test mới, domain dispatch này trước đó chưa có test riêng).

## Thứ tự thực thi

```
Độc lập, làm bất cứ lúc nào (không phụ thuộc nhau, không phụ thuộc nhóm dưới):
  001 (audit GlobalSettings credential fields — chặn CR-STORAGE-003 ở backend-go/frontend)
  002 (verify health-reporter cadence)
  003 (clarify bootstrap_status ownership)
  004 (fix stale reconnect docs)

Chuỗi bắt buộc theo thứ tự cho CR-STORAGE-008(b):
  005 (chốt 3 quyết định thiết kế — BẮT BUỘC xong trước 006/007/009)
   → 006 (build daemon)
      → 007 (rewire agent-spawner.ts + agent-session.ts)
         → 008 (khớp grace-period với backend-go, có thể làm song song với 009)
         → 009 (đồng bộ desktop/ mirror nếu cần + integration test toàn chuỗi)
```

## Vì sao 001–004 tách khỏi 005–009

001–004 xuất phát từ SOL-AG-STORAGE-001/002 — đều là các việc **xác nhận/
điều tra nhỏ, độc lập**, không có chuỗi phụ thuộc giữa chúng và không phụ
thuộc vào công việc daemon lớn ở SOL-AG-STORAGE-003. 005–009 là **1 chuỗi
implementation liền mạch** cho CR-STORAGE-008(b) (điểm cốt lõi nhất của cả
đợt CR-STORAGE-00x phía agent, xem phát hiện `ORCH-011` trong
`SOL-AG-STORAGE-003`) — các task này PHẢI làm theo đúng thứ tự vì mỗi task
sau xây trên kết quả cụ thể (quyết định thiết kế, hoặc code) của task
trước, không thể chạy song song.

## Nguyên tắc chung khi thực thi các task này

1. **Không giả định — luôn đọc code thật trước khi viết.** Cả 3 solution
   gốc đều được xây trên việc đọc `agent/src/relay/` trực tiếp thay vì tin
   `specs/agent/tdd/`; các task ở đây tiếp tục kỷ luật đó (TASK-004 thậm
   chí tồn tại chỉ để sửa 1 chỗ TDD sai).
2. **005 là cổng chặn cho 006/007/009** — không bắt đầu viết code daemon
   mới trước khi 3 câu hỏi ở 005 (vị trí OSC state machine, 1 daemon hay 2,
   `desktop/` còn sống hay không) có câu trả lời ghi lại rõ ràng.
3. **Không đổi wire contract hiện có** (`agent.spawn`/`agent.kill`/params)
   trừ khi task nói rõ — mục tiêu là đổi **nơi PTY vật lý sống**, không đổi
   giao thức Orca Server/frontend đã phụ thuộc.
4. **Mỗi task implementation đều có acceptance criteria + lệnh verification
   cụ thể** (`tsc --noEmit`, `vitest run`) — chạy trước khi coi task hoàn
   thành, không chỉ dựa vào đọc lại code bằng mắt.
