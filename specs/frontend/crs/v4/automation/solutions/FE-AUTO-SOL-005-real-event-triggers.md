# FE-AUTO-SOL-005: Xoá `AutomationEventBridge.ts` (dead code) + trigger type `external` + tín hiệu "agent hoàn thành"

> **🔲 Designed — chưa implement.**

**CR:** [CR-AUTO-005](../../../../../../docs/crs/v4/automations/CR-AUTO-005-real-event-triggers.md)
**backend-go counterpart:** [BE-AUTO-SOL-005](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-005-real-event-triggers.md)
**Layer:** renderer (trigger UI) + Electron main (xoá dead code, hook tín hiệu)

---

## 1. Trạng thái hiện tại

`desktop/src/main/automations/AutomationEventBridge.ts` — dead code xác
nhận (`grep "new AutomationEventBridge"` chỉ khớp doc-comment của chính
nó; gọi `automationService.dispatchAutomation` — method không tồn tại).
`AutomationRunTrigger = 'scheduled' | 'manual'` — không có `'external'`.

Tín hiệu "agent hoàn thành" gần nhất tồn tại thật: `AgentDetector`
(`desktop/src/main/stats/agent-detector.ts`) — theo dõi working→idle
transition per-PTY qua OSC title (`detectAgentStatusFromTitle`), đóng
"work session" khi chuyển từ `working` sang khác `working`
(`agent-detector.ts:160-175`). Dùng cho usage stats (`StatsCollector`)
hôm nay, **chưa từng dùng cho automation trigger** — cần validate lại
đây có phải đúng khái niệm "task xong" hay chỉ là "agent tạm ngừng gõ"
(agent có thể idle giữa chừng task dài, không nhất thiết nghĩa là xong
việc — rủi ro false-positive cần cân nhắc kỹ trước khi dùng làm trigger
tự động).

## 2. Giải pháp

### Xoá dead code

Xoá `AutomationEventBridge.ts`. Sửa
`specs/backend/bugs/automation/BUG-BE-AT-001-event-based-automation-not-implemented.md`'s
status về đúng thực tế, trỏ sang CR-AUTO-005.

### Mở rộng trigger type

```ts
// automations-types.ts
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'external'
```
`AutomationEditorDialog.tsx`'s trigger picker (`AutomationSchedulePicker.tsx`)
thêm option "External" — khi chọn, form hiển thị hướng dẫn (không phải
input, external trigger được gọi từ ngoài qua `HandleExternalTrigger`,
không cấu hình lịch) + hiển thị `request_id`/endpoint liên quan để user
biết cách trigger từ ngoài (copy-able, tương tự UI đã có cho các kiểu
external integration khác trong app nếu có — tái dùng pattern nếu tìm
thấy).

### Tín hiệu "agent hoàn thành" — cần validate trước khi wire

**Không tự động wire `AgentDetector`'s session-close event vào
`HandleExternalTrigger` trong solution này** — cần 1 bước xác nhận sản
phẩm riêng (giống CR-EVM-010's cùng câu hỏi): liệu "agent chuyển từ
working sang idle" có đúng nghĩa "task automation nên coi là hoàn thành"
hay không, đặc biệt vì đây vốn là tín hiệu cho billing/usage (sai lệch ở
đây ảnh hưởng cả automation lẫn stats nếu dùng chung). Nếu xác nhận phù
hợp: thêm 1 hook trong `RuntimePtyExitCommands`/`AgentDetector`'s session
close path gọi 1 RPC mới (`automation.notifyAgentSessionEnded` hoặc
tương tự) → forward tới backend-go's `HandleExternalTrigger` (qua
`callRuntimeRpc` nếu automation liên quan đang ở pairing-path, hoặc gọi
thẳng Electron-local scheduler nếu automation ở `{kind:'local'}`).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `AgentDetector`'s tín hiệu có thể không đúng nghĩa "task xong" | Cao | Đây là rủi ro chính của cả CR-AUTO-005 lẫn CR-EVM-010 — không code hook thật cho tới khi xác nhận |
| Phụ thuộc MỀM BE-AUTO-SOL-005 | Trung bình | Cần biết `HandleExternalTrigger`'s auth đã sẵn sàng nhận caller nội bộ chưa |

## Không thuộc phạm vi solution này

- Auth logic phía backend-go — xem BE-AUTO-SOL-005.
- Circular-trigger detection UI (nếu cần hiển thị cảnh báo) — chưa scope, theo dõi ở BE-AUTO-SOL-005.

## Liên quan

- `desktop/src/main/automations/AutomationEventBridge.ts` (xoá)
- `desktop/src/main/stats/agent-detector.ts:160-175`
- `frontend/src/shared/automations-types.ts:18`
- `frontend/src/renderer/src/components/automations/AutomationSchedulePicker.tsx`
- [BE-AUTO-SOL-005](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-005-real-event-triggers.md)
- [CR-EVM-010](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-010-auto-destroy-on-task-completion.md) (cùng câu hỏi tín hiệu, nhóm ephemeral-vm)
