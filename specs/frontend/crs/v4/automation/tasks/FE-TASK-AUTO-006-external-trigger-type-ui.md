# FE-TASK-AUTO-006: `AutomationRunTrigger = 'external'` + trigger picker UI

**Solution:** [FE-AUTO-SOL-005](../solutions/FE-AUTO-SOL-005-real-event-triggers.md) | **CR:** CR-AUTO-005
**Depends on:** [TASK-BE-AUTO-008](../../../../backend-go/crs/v4/automations/tasks/TASK-BE-AUTO-008-external-trigger-auth.md) (mềm — nên đợi auth xong trước khi expose UI)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Thêm option "External" vào trigger picker.

## Files cần sửa

1. `frontend/src/shared/automations-types.ts` (MODIFY)
2. `frontend/src/renderer/src/components/automations/AutomationSchedulePicker.tsx` (MODIFY)

## Nội dung

```ts
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'external'
```

Trigger picker: thêm option "External" — khi chọn, hiển thị hướng dẫn
(không phải input lịch) + thông tin cần thiết để trigger từ ngoài (theo
đúng shape `HandleExternalTriggerRequest`, đọc proto trước khi hiển thị
field nào).

## Test cases cần cover

- Chọn "External" → form không hiển thị input lịch (cron), hiển thị
  đúng hướng dẫn.
- Automation đã tạo với trigger `external` → hiển thị đúng badge/label
  trong list.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/automations/AutomationSchedulePicker.test.tsx
npx tsc --noEmit
```

## gitnexus

`impact({target: "AutomationRunTrigger", direction: "downstream"})` —
xác nhận mọi switch/render theo trigger type được cập nhật đủ case mới,
không bỏ sót.

---

## ✅ Kết quả thực tế (2026-09-09)

**Ghi chú thực thi**: task này được giao cho 1 agent chạy trong git
worktree cô lập (song song với FE-TASK-AUTO-003 để tăng tốc), sau đó
merge thủ công vào working tree thật — xem "Phát hiện thêm khi merge" ở
cuối mục này cho phần phát sinh riêng trong bước merge.

### Proto thật (đã đọc trước khi code UI)

`backend-go/proto/orca/automation/v1/automation.proto`:

```proto
message HandleExternalTriggerRequest {
  string automation_id = 1;
  string request_id = 2; // external source's idempotency key
  string payload_json = 3; // opaque external payload; passed through as-is, not interpreted here
}
```

3 field đúng như sketch dự đoán (`automation_id`, `request_id`,
`payload_json`) — không có field nào khác, không có auth token field
(auth đi qua tenant identity chuẩn của gRPC call, theo TASK-BE-AUTO-008,
không phải field riêng trong request).

### Sai lệch so với sketch — quan trọng, đọc trước khi dùng lại UI này

Sketch giả định "trigger picker" (`AutomationSchedulePicker.tsx`) có thể
gắn "External" trực tiếp vào state đã lưu của automation. Đọc code thật
thì **`Automation` (kiểu đã lưu) không có field nào biểu diễn "trigger
mode"** — chỉ có `rrule`/`dtstart` (luôn là 1 lịch cron/rrule thật).
`AutomationRunTrigger` chỉ tồn tại trên **`AutomationRun`** (mỗi lần
chạy), không trên `Automation` (cấu hình). Và không có RPC/field nào ở
backend cho phép lưu "automation này được trigger từ ngoài" — khớp với
brief: TASK-BE-AUTO-009 (caller thật gọi `HandleExternalTrigger`) vẫn
blocked, chưa tồn tại.

→ Chọn cách an toàn nhất, không đoán thêm field mới ở backend chưa tồn
tại: option "External" trong `AutomationSchedulePicker` là **state cục
bộ, chỉ tồn tại trong phiên chỉnh sửa của component** (`useState`), tách
biệt hoàn toàn khỏi `draft.preset`/`AutomationSchedulePreset` (cadence
thật) và khỏi luồng Save (`AutomationsPage.tsx`'s `buildAutomationRrule`
path không hề bị chạm tới). Chọn "External" chỉ đổi UI hiển thị (ẩn
input lịch, hiện hướng dẫn đọc `HandleExternalTriggerRequest`) — **không
làm gì tới việc automation thực sự được lưu như thế nào**, vì hiện tại
chưa có chỗ để lưu điều đó. Đây là preview/hướng dẫn thuần UI, đúng như
brief: "not building the caller side".

Hệ quả cần biết: đóng/mở lại dialog edit một automation đã lưu sẽ luôn
hiện lại "Scheduled" (vì không có gì để đọc lại) — đây không phải bug,
là giới hạn thật của data model hiện tại. Khi TASK-BE-AUTO-009 (hoặc một
CR riêng) thêm field lưu trigger mode ở `Automation`, cần một task theo
dõi riêng để nối `triggerMode` này vào draft/save thật.

### Test case 2 ("automation đã tạo với trigger external hiển thị đúng badge/label trong list") — không có UI sẵn để gắn vào

Sketch giả định có sẵn chỗ hiển thị badge trigger trong "automations
list". Grep thật (`grep -rn "'scheduled'\|'manual'\|\.trigger\b"
frontend/src`) cho thấy **chưa từng có UI nào hiển thị `AutomationRun`'s
`trigger` field** — chỉ có status badge (`getAutomationRunStatusLabel`/
`getAutomationRunStatusVariant` trong `automation-page-parts.tsx`, dùng
ở `AutomationRunHistory.tsx`'s run rows). Đã thêm mới:
- `getAutomationRunTriggerLabel()` trong `automation-page-parts.tsx`
  (switch exhaustive, không default — thêm giá trị
  `AutomationRunTrigger` mới mà quên case sẽ fail typecheck).
- Badge thứ 2 (`variant="outline"`) cạnh status badge trong mỗi run row
  ở `AutomationRunHistory.tsx`.

### Files đã sửa

- `frontend/src/shared/automations-types.ts` — `AutomationRunTrigger`
  thêm `'external'`.
- `frontend/src/renderer/src/components/automations/AutomationSchedulePicker.tsx`
  — thêm Select "Trigger" (Scheduled/External) ở đầu panel; chọn
  "External" ẩn toàn bộ Cadence/Day/Time/Custom-cron UI, hiện hướng dẫn
  read-only (không phải form — theo đúng yêu cầu "not an interactive
  form", không có nút copy) liệt kê 3 field của
  `HandleExternalTriggerRequest`. Icon trigger button đổi CalendarClock ↔
  Webhook (lucide-react) theo mode.
- `frontend/src/renderer/src/components/automations/AutomationExternalTriggerGuidance.tsx`
  (MỚI — xem "Phát hiện thêm khi merge" bên dưới, không có trong lần
  implement gốc của agent).
- `frontend/src/renderer/src/components/automations/automation-page-parts.tsx`
  — thêm `getAutomationRunTriggerLabel()`.
- `frontend/src/renderer/src/components/automations/AutomationRunHistory.tsx`
  — render badge trigger cạnh badge status trong mỗi run row.
- `frontend/src/renderer/src/components/automations/AutomationSchedulePicker.test.tsx`
  (MỚI) — 4 test, gồm 2 test case bắt buộc của task này.
- `frontend/src/renderer/src/components/automations/AutomationRunHistory.test.tsx`
  (MỚI) — 2 test, cover test case 2 (không có sẵn test file nào để gắn
  vào nên tạo mới thay vì sửa file có sẵn).

### Test names thật (đã chạy thật, không giả định pass)

`AutomationSchedulePicker.test.tsx`:
1. `shows the Cadence schedule field by default`
2. `selecting External hides the cron/schedule input and shows the correct guidance`
3. `switching back to Scheduled restores the Cadence field`
4. `does not mutate the draft when switching trigger mode (no persisted field yet)`

`AutomationRunHistory.test.tsx`:
1. `displays an 'External' badge for a run created with trigger: 'external'`
2. `still shows 'Scheduled' and 'Manual' badges for the pre-existing trigger values`

### gitnexus — không resolve được, đã dùng phương án thay thế

`impact({target: "AutomationRunTrigger", direction: "downstream"})` trả
`"Target 'AutomationRunTrigger' not found"` — gitnexus's schema (File,
Folder, Function, Class, Interface, Method, CodeElement, ...) không có
node kind cho TypeScript `type` alias union, nên không resolve được
symbol này (xác nhận thêm qua `cypher` query trực tiếp trên node có
`name = 'AutomationRunTrigger'` → 0 kết quả). Đây là giới hạn thật của
tool, không phải lỗi thao tác.

Thay vào đó xác nhận thủ công bằng `codegraph_explore` (blast radius có
sẵn cho `AutomationRunTrigger`) + `grep -rn "AutomationRunTrigger\|\.trigger\b"
frontend/src` — chỉ có 2 chỗ thật switch/đọc theo `trigger`:
1. `useAutomationDispatchEvents.ts:170` — `run.trigger === 'scheduled'`
   (so sánh bằng, không phải switch exhaustive — không cần sửa, hành vi
   đúng với `'external'` tự nhiên: chỉ chạy precheck cho run
   `scheduled`, giống hệt cách `'manual'` đã được xử lý từ trước).
2. `automation-page-parts.tsx`'s `getAutomationRunTriggerLabel()` (MỚI,
   thêm cùng task này) — switch exhaustive, đã có case `'external'`.

Không tìm thấy chỗ nào khác switch theo `AutomationRunTrigger` mà thiếu
case `'external'`.

### Phát hiện thêm khi merge (2026-09-09, không phải lúc agent implement gốc)

Agent thực thi task này chạy trong worktree cô lập, rẽ nhánh trước khi
FE-TASK-AUTO-002's action-chain types land — nên `automations-types.ts`
ở đó chưa đủ dài để chạm `max-lines`. Khi merge code thật (agent's diff)
vào working tree thật — nơi FE-TASK-AUTO-002 đã thêm
`AutomationAction`/`AutomationActionType`/`AutomationActionResult`/
`Automation.actions?`/`maxRunHistory?`/`runTimeoutSeconds?` VÀ task này
cùng lúc thêm `AutomationRunTrigger`'s doc comment — **tổng cộng vượt
max-lines** (`automations-types.ts`: 312 dòng > 300; đồng thời
`AutomationSchedulePicker.tsx` sau khi thêm Select "Trigger" +
`ExternalTriggerGuidance` inline: 428 dòng > 400) — phát hiện qua chạy
`npx oxlint` thật sau merge, không phải giả định.

**Xử lý (đúng AGENTS.md's "không disable, không xin baseline exception")**:
1. `automations-types.ts` → tách toàn bộ nhóm type `ExternalAutomation*`
   (Hermes/OpenClaw external-manager domain, không liên quan CR-AUTO-002/
   CR-AUTO-005) sang file mới `automations-external-types.ts`, re-export
   qua `export * from './automations-external-types'` — không đổi bất kỳ
   import site nào (7 file khác import `ExternalAutomation*` vẫn hoạt
   động nguyên vẹn qua barrel).
2. `AutomationSchedulePicker.tsx` → tách hàm `ExternalTriggerGuidance`
   (không nhận prop, tự chứa hoàn toàn) sang file riêng
   `AutomationExternalTriggerGuidance.tsx`, export tên
   `AutomationExternalTriggerGuidance` (khớp tên file, đúng convention
   component trong thư mục này).

Cả 2 file sau khi tách đều `npx oxlint` sạch (xác nhận thật, không giả
định).

### Verify (chạy thật trên working tree thật, sau merge)

```
cd frontend
npx vitest run src/renderer/src/components/automations/AutomationSchedulePicker.test.tsx
  # PASS 4/4
npx vitest run src/renderer/src/components/automations/AutomationRunHistory.test.tsx
  # PASS 2/2
npx vitest run src/renderer/src/components/automations/
  # PASS 127/128 — 1 fail KHÔNG liên quan (automation-project-groups.test.ts,
  # file không ai trong 2 agent + merge đụng tới, xác nhận qua git diff
  # rỗng cho file đó — tiền sự cố từ session khác trên cùng working
  # directory, không phải do task này)
npx oxlint src/renderer/src/components/automations/ src/shared/automations-types.ts src/shared/automations-external-types.ts
  # sạch — 0 finding, xác nhận max-lines đã hết vi phạm sau khi tách 2 file
npx tsc --noEmit -p .
  # 0 lỗi liên quan automations (đã grep xác nhận) — lỗi tsc khác thấy
  # được trên toàn repo đều pre-existing, không liên quan
```
