# FE-SOL-EVM-006: Auto-suspend/destroy VM sau khi task hoàn thành

> **🔲 Designed — chưa implement.** Bước 1 (khảo sát event source) chưa
> xong trong solution này — xem mục 2.

**CR:** [CR-EVM-010](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-010-auto-destroy-on-task-completion.md)
**Layer:** renderer + Electron main
**TDD tham chiếu:** không có mục riêng — dùng code thật làm nguồn

---

## 1. Trạng thái hiện tại

`suspendRuntimeEphemeralVmWorkspace`/`cleanupRuntimeEphemeralVmWorkspace`
đã tồn tại, gọi thủ công qua `EphemeralVmRuntimesSection.tsx:88-132`
(nút Cleanup) hoặc `cleanupEphemeralVmRuntimesForDeleted`
(`ephemeral-vm-runtime-cleanup.ts:21-56`, khi xoá workspace/repo). Không
hook nào từ "agent hoàn thành" — xem mục 2.

## 2. Tín hiệu ứng viên (chưa xác nhận đủ tin cậy)

`AgentDetector` (`desktop/src/main/stats/agent-detector.ts`) — theo dõi
working→idle qua OSC title, đóng "work session" khi agent dừng
`working`. Dùng cho usage stats hôm nay, **chưa validate cho mục đích
automation/VM-lifecycle**. Cùng câu hỏi với
[FE-AUTO-SOL-005](../../../../frontend/crs/v4/automation/solutions/FE-AUTO-SOL-005-real-event-triggers.md)
(nhóm Automations) — nên khảo sát/quyết định chung 1 lần, không làm 2
lần độc lập.

## 3. Giải pháp (giả định tín hiệu ở mục 2 được xác nhận phù hợp)

### Chính sách mặc định: suspend, không destroy

Khớp CR-EVM-010's khuyến nghị — an toàn hơn, đã có RPC sẵn sàng.

### Wiring

Trong `RuntimePtyExitCommands`/`AgentDetector`'s session-close path
(Electron main), với PTY thuộc 1 workspace backed bởi ephemeral VM
(kiểm tra `experimentalEphemeralVms` bật + workspace's `hostId` là
runtime ephemeral) — gọi `suspendRuntimeEphemeralVmWorkspace`. Cần thêm
1 lookup "PTY này thuộc workspace nào, workspace đó có ephemeral VM
runtime không" — kiểm tra `RuntimeGraphStore`/`RuntimePtyWorktreeRecord`
đã có đủ thông tin này chưa trước khi thêm field mới.

### Cấu hình per-workspace (tuỳ chọn)

Checkbox "Keep VM running after task" trong runtime settings panel
(`EphemeralVmRuntimesSection.tsx` hoặc composer), mặc định off (tức mặc
định auto-suspend bật).

### Idempotency

Xác nhận `suspendRuntimeEphemeralVmWorkspace` gọi 2 lần không lỗi (đọc
implementation trước khi wire — sự kiện idle có thể bắn nhiều lần cho
cùng session nếu agent tạm dừng rồi lại "idle" theo state machine của
`AgentDetector`).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Tín hiệu `AgentDetector` chưa validate cho mục đích này | Cao | Không code mục 3 cho tới khi mục 2 được xác nhận — phối hợp với FE-AUTO-SOL-005 |
| Auto-suspend nhầm khi user muốn tiếp tục dùng VM | Trung bình | Checkbox tắt per-workspace giảm rủi ro |
| Sự kiện bắn nhiều lần | Thấp | Cần idempotency, xem mục 3 |

## Không thuộc phạm vi solution này

- Định nghĩa lại "task xong" ở tầng automation/task-graph nói chung.

## Liên quan

- `desktop/src/main/stats/agent-detector.ts:160-175`
- `desktop/src/main/runtime/orca-runtime-pty-exit.ts:76` (`getAgentDetector()?.onExit(ptyId)`)
- `frontend/src/renderer/src/components/settings/EphemeralVmRuntimesSection.tsx:88-132`
- `frontend/src/renderer/src/lib/sleep-worktree-flow.ts:150-163`
- [FE-AUTO-SOL-005](../../../../frontend/crs/v4/automation/solutions/FE-AUTO-SOL-005-real-event-triggers.md) (cùng câu hỏi tín hiệu, nhóm Automations)
