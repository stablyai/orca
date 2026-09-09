# FE-TASK-AUTO-007: Khảo sát tín hiệu "agent hoàn thành" — KHÔNG PHẢI TASK CODE

**Solution:** [FE-AUTO-SOL-005](../solutions/FE-AUTO-SOL-005-real-event-triggers.md) | **CR:** CR-AUTO-005
**Depends on:** Không
**Status:** ⛔ BLOCKED — cần xác nhận sản phẩm, AI không tự thực thi code cho task này

---

## Mục tiêu

Đây là task **khảo sát + báo cáo**, không phải task viết code. AI thực
thi task này chỉ được phép:
1. Đọc `desktop/src/main/stats/agent-detector.ts` kỹ, xác nhận chính
   xác semantics của working→idle transition (khi nào coi là "session
   đóng").
2. Đọc mọi call site hiện tại của `AgentDetector`'s session-close
   event/state, xác nhận nó KHÔNG được dùng cho mục đích nào ngoài
   `StatsCollector` (usage stats) hôm nay.
3. Viết báo cáo (trong chính file này, mục "Kết quả khảo sát" bên dưới)
   trả lời rõ: tín hiệu này có đáng tin để dùng làm "task hoàn thành" cho
   automation/VM lifecycle hay không — nêu rõ trường hợp false-positive
   cụ thể tìm được (nếu có).

**KHÔNG được**: viết hook mới, sửa `AgentDetector`, thêm RPC gọi
`HandleExternalTrigger`/`suspendRuntimeEphemeralVmWorkspace` — mọi việc
đó chờ ở
[FE-TASK-AUTO-006](./FE-TASK-AUTO-006-external-trigger-type-ui.md)'s
phần mở rộng SAU KHI có xác nhận sản phẩm (task riêng, chưa tồn tại,
tạo sau khi quyết định).

## Phối hợp

Cùng câu hỏi với `docs/crs/v3/ephemeral-vm/`'s CR-EVM-010 — nên khảo sát
1 lần dùng chung cho cả 2 nhóm CR, không lặp lại.

## Kết quả khảo sát (2026-09-09)

**Kết luận: `AgentDetector`'s tín hiệu KHÔNG đủ tin cậy để dùng trực
tiếp làm "task hoàn thành" cho automation/VM lifecycle — cần 1 lớp diễn
giải bổ sung, không dùng thẳng.**

### Semantics thật (`desktop/src/main/stats/agent-detector.ts:141-175`)

- Tín hiệu là **per-PTY, dựa trên OSC terminal title heuristic**
  (`detectAgentStatusFromTitle`), không phải "task"/"run" theo nghĩa
  chính thức nào — 1 PTY tương ứng 1 terminal tab, có thể chứa nhiều
  phiên làm việc agent liên tiếp (comment file tự ghi: "one long-lived
  PTY can contribute multiple agent sessions").
- `onAgentStop` (`stats.onAgentStop`) fire khi title chuyển từ `working`
  sang trạng thái khác `working` **HOẶC** khi PTY exit
  (`onExit:181-195`) — nghĩa là: agent tạm dừng gõ giữa 2 prompt (đợi
  user trả lời) cũng kích hoạt `onAgentStop`, y hệt như khi agent thực
  sự xong việc. **Đây chính là false-positive cụ thể**: 1 agent đang
  chờ user xác nhận 1 hành động ("Yes/No?") sẽ trông giống hệt "đã xong
  task" qua tín hiệu này.
- Field `sessionOpen` tự mở lại (`!record.sessionOpen && status ===
  'working'`) khi agent quay lại `working` sau đó — xác nhận đây là
  chu kỳ working↔idle lặp lại bình thường trong 1 phiên làm việc dài,
  không phải ranh giới "task" 1 lần.

### Call site hiện tại (bước 2 xác nhận)

`grep` xác nhận: `stats.onAgentStop`/`onAgentStart` chỉ có **1 consumer
thật** — nội bộ `StatsCollector` tự ghi `agent_stop`/`agent_start` event
vào `aggregates.totalAgentTimeMs` (dùng cho usage stats/billing).
`StatsCollector` có `onAgentStarted(listener)` — 1 hook subscribe được
cho sự kiện START (dùng bởi "star-nag" service, theo comment dòng 58-60)
— nhưng **KHÔNG có `onAgentStopped(listener)` tương ứng cho STOP**. Muốn
dùng tín hiệu này cho automation/VM lifecycle sẽ cần thêm 1 hook mới
kiểu đó trước, không có sẵn để subscribe hôm nay.

### Khuyến nghị

- **Không dùng thẳng `AgentDetector`'s working→idle làm trigger.**
- Nếu vẫn muốn dùng làm nền tảng: cần thêm (a) `onAgentStopped(listener)`
  hook đối xứng với `onAgentStarted`, VÀ (b) 1 lớp lọc false-positive —
  ví dụ chỉ coi là "task xong" nếu idle kéo dài quá N giây (không phải
  chuyển trạng thái tức thời), hoặc chờ tín hiệu PTY exit
  (`onExit`) thay vì working→idle giữa chừng — PTY exit không có vấn đề
  "đang chờ user" vì phiên đã thực sự kết thúc.
- **Phương án thay thế đáng cân nhắc**: nếu automation/ephemeral-VM chỉ
  cần biết "agent RPC call (agent.exec) đã trả kết quả", tín hiệu đó đã
  có sẵn tại chính điểm gọi (response của `agent.exec`/PTY exit), không
  cần qua `AgentDetector` — rẻ hơn và chính xác hơn cho trigger tự động,
  dù mất khả năng phát hiện "agent xong 1 prompt nhưng còn ở lại session"
  (trade-off cần quyết định sản phẩm, không tự chọn ở đây).

### Việc còn lại (chờ quyết định sản phẩm)

Không tự triển khai — trả lại câu hỏi cho CR-AUTO-005/CR-EVM-010: chọn
1 trong 2 hướng trên (mở rộng `AgentDetector` với filter, hoặc dùng tín
hiệu PTY-exit/RPC-response trực tiếp) trước khi
[FE-TASK-AUTO-006](./FE-TASK-AUTO-006-external-trigger-type-ui.md)'s
phần mở rộng và
[FE-TASK-EVM-008](../../../v3/ephemeral-vm/tasks/FE-TASK-EVM-008-auto-suspend-on-task-completion.md)
có thể tiếp tục.
