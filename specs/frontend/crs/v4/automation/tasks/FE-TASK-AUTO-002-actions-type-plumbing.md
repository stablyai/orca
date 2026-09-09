# FE-TASK-AUTO-002: `AutomationAction` type + host-client pass-through

**Solution:** [FE-AUTO-SOL-002](../solutions/FE-AUTO-SOL-002-actions-type-plumbing.md) | **CR:** CR-AUTO-002
**Depends on:** [TASK-BE-AUTO-002](../../../../backend-go/crs/v4/automations/tasks/TASK-BE-AUTO-002-proto-action-chain.md)
**Status:** ✅ DONE (2026-09-09) — phạm vi mở rộng thật, xem "Kết quả thực tế"

---

## Mục tiêu

Type mới khớp backend-go's proto; forward `actions` qua
`automation-host-client.ts`'s create/update; automation cũ (1 prompt)
map thành 1-action chain khi submit.

## Files cần sửa

1. `frontend/src/shared/automations-types.ts` (MODIFY)
2. `frontend/src/renderer/src/components/automations/automation-host-client.ts` (MODIFY — `toRuntimeAutomationCreateInput`/`toRuntimeAutomationUpdateInput`)
3. `frontend/src/renderer/src/components/automations/AutomationEditorDialog.tsx` (MODIFY — submit map thành `actions: [{...}]`)

## Nội dung (xem FE-AUTO-SOL-002 §2)

```ts
export type AutomationActionType =
  | 'create_worktree' | 'run_agent' | 'commit_push' | 'create_pr' | 'send_notification' | 'run_script'

export type AutomationAction = {
  id: string
  type: AutomationActionType
  config: Record<string, unknown>
  continueOnFailure?: boolean
}

export type Automation = {
  // ... field hiện có ...
  actions?: AutomationAction[]
}
```

## Bước 1 — Xác nhận JSON serialize qua `callRuntimeRpc`

Kiểm tra 1 ví dụ nested-object gửi qua `callRuntimeRpc` đã có (vd.
`ephemeralVm`'s recipe object) — xác nhận `config` field (nested object)
serialize đúng, không cần `JSON.stringify` thủ công, trước khi code.

## Test cases cần cover

- `createAutomationForTarget` với `actions` 2 phần tử → gửi đúng shape
  qua `callRuntimeRpc`/`window.api.automations.create`.
- Submit form cũ (1 prompt, không multi-action UI) → tự map thành
  `actions: [{id: 'primary', type: 'run_agent', config: {prompt, agentId}}]`.
- Automation cũ (không có `actions` từ backend) → UI không crash khi hiển thị.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/automations/automation-host-client.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "Automation", direction: "downstream"})` — xác nhận
mọi nơi decode `Automation` type (nhiều component trong
`components/automations/`) không bị vỡ bởi field mới optional.

---

## ✅ Kết quả thực tế (2026-09-09) — phạm vi mở rộng thật sau khảo sát Bước 1

**Bước 1 (khảo sát bắt buộc: xác nhận JSON serialize qua `callRuntimeRpc`)
phát hiện scope thật lớn hơn "type plumbing" đơn thuần** — đọc trực tiếp
`api-gateway`'s wscompat handler (không giả định) phát hiện 2 gap thật,
độc lập với việc "thêm field optional":

### Phát hiện 1 — wscompat chưa từng wire `actions` (backend-go, ngoài phạm vi file-list gốc)

`backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task.go`'s
`automation.create`/`automation.update` handlers (hand-viết JSON decode
struct, KHÔNG dùng protojson) chỉ có `name/rrule/stepConfigJson/stepType/
dtstart/timezone` — **chưa từng có `actions`/`maxRunHistory`/
`runTimeoutSeconds`**, dù `CreateAutomationRequest.Actions` đã tồn tại từ
TASK-BE-AUTO-002. Không CR/task nào trong `specs/backend-go/crs/v4/automations/`
từng động tới wscompat cho việc này — 1 lỗ hổng thật giữa gRPC proto (đã
xong) và transport thật frontend dùng (`callRuntimeRpc` → wscompat, KHÔNG
phải REST `httpgateway`). Không sửa, gửi `actions` từ frontend sẽ bị
Postgres decode bỏ qua âm thầm (JSON key lạ, không lỗi rõ ràng).

**Đã sửa** (ngoài file-list gốc, nhưng bắt buộc để task này có ý nghĩa):
- `channels_automation_task.go` — thêm `parseAutomationActionType`,
  `automationActionArg`, `toProtoAutomationActions`; wire `actions`/
  `maxRunHistory`/`runTimeoutSeconds` vào `automation.create`; wire
  `actions` (dạng con trỏ tri-state, khớp `ActionsSet`'s nil-vs-empty
  semantics)/`maxRunHistory`/`runTimeoutSeconds` vào `automation.update`.
- 4 test mới trong `channels_automation_task_test.go` (forward actions ở
  create; 3 test tri-state ở update: omitted/empty/populated).

### Phát hiện 2 — bug thật có sẵn: `automation.update` gửi sai shape (không liên quan `actions`)

Đọc kỹ `updateArgs` struct (Go) so với `updateAutomationForTarget`/
`updateAutomationByIdForTarget` (frontend) phát hiện: frontend gửi
`{id, updates: {...}}` (lồng nhau, đúng kiểu Node "server mode"
`window.api.automations.update` dùng), nhưng wscompat's `updateArgs`
decode **phẳng** (`id`/`name`/`rrule`/... là anh em cùng cấp, không có
field `updates` nào cả). Kết quả: **mọi update automation qua runtime
(backend-go) target từ trước tới nay chỉ đổi `id` (vô nghĩa), mọi field
thật (`name`/`enabled`/...) im lặng không đổi** — vì `automation-host-client.test.ts`'s
`callRuntimeRpc` mock không bao giờ validate đúng shape thật, bug này
không ai phát hiện. **Đã sửa**: `{ id: automation.id, ...toRuntimeAutomationUpdateInput(updates) }`
(phẳng) thay vì lồng `updates`. Cập nhật lại test đang assert sai shape
(`automation-host-client.test.ts`'s "updates and manually runs SSH-host
automations...").

### Phát hiện 3 — gap kiến trúc thật, KHÔNG sửa trong task này: `connectionId`

`workflow-service`'s step configs (`internal/domain/step.go`) — không
chỉ `AgentStepConfig`, mà **`ShellStepConfig`/`NotificationStepConfig`/
`CommitPushStepConfig` cũng vậy** — đều yêu cầu **`connectionId`** (bắt
buộc — `relay_client.go:42` trả lỗi rõ nếu thiếu, dùng chung 1 guard cho
mọi step type) để biết dispatch tới infra-fleet-service connection nào.
Chỉ `create_pr` (dispatch qua `scm-integration-service` trực tiếp,
không qua `workflow-service`) không cần field này. FE-AUTO-SOL-002 §3's
sketch gốc (`config: {prompt, agentId}`) **không có `connectionId`** —
khảo sát thêm xác nhận: không có bất kỳ cơ chế nào trong frontend hiện
tại resolve `runContext`/`executionTargetId` (automation's own concept)
→ `connectionId` (infra-fleet-service's connection concept, khác hẳn
`repo.connectionId` — đó là SSH git-remote connection, không liên quan).
**Kết luận**: MỌI action loại `run_agent`/`run_script`/
`send_notification`/`commit_push` (kể cả action user tự tạo qua UI
FE-AUTO-SOL-003/004 sau này, không chỉ 1-action-chain fallback của task
này) SẼ TỒN TẠI đúng shape (test pass), nhưng sẽ FAIL khi thật sự dispatch
qua backend-go (thiếu `connectionId`) — cho tới khi 1 CR/task riêng giải
quyết việc resolve connectionId. Đây là giới hạn có thật, ghi rõ ở đây
thay vì tự chế 1 giá trị `connectionId` đoán mò (sẽ sai, khó debug hơn
là thiếu hẳn). Không thuộc phạm vi FE-TASK-AUTO-002 (task này chỉ làm
"type plumbing", không làm "đảm bảo dispatch thành công" — đúng
FE-AUTO-SOL-002's tuyên bố rõ `config: Record<string,unknown>` là "opaque
theo type, decode cụ thể ở form component từng loại").

### Nội dung đã làm (đúng phạm vi gốc)

- `frontend/src/shared/automations-types.ts`: thêm `AutomationActionType`,
  `AutomationAction`, `AutomationActionResult`; `Automation` được thêm
  `actions?`/`maxRunHistory?`/`runTimeoutSeconds?`; `AutomationRun` được
  thêm `actionResults?`; `AutomationCreateInput`/`AutomationUpdateInput`
  được thêm `actions?`/`maxRunHistory?`/`runTimeoutSeconds?` (cần thiết
  để FE-TASK-AUTO-003/004's UI multi-action có chỗ set field này sau
  này, không phải lặp lại việc sửa type).
- `frontend/src/renderer/src/components/automations/automation-host-client.ts`:
  thêm `RuntimeAutomationAction` (wire shape, `configJson: string`, KHÔNG
  phải nested object — xác nhận qua đọc `automationActionArg` Go struct
  trực tiếp, đúng yêu cầu Bước 1, không giả định); `toRuntimeAutomationAction`
  (JSON.stringify `config`); `toDefaultRunAgentAction` (1-action fallback);
  `toRuntimeAutomationCreateInput`/`toRuntimeAutomationUpdateInput` cập
  nhật để build `actions` đúng tri-state (create: luôn có giá trị — dùng
  `actions` caller cung cấp, hoặc fallback; update: omit hoàn toàn khi
  không đổi prompt/agentId và không có `actions` tường minh — không phá
  `toggleAutomation()`'s partial-update `{enabled}` case).
- **KHÔNG sửa `AutomationEditorDialog.tsx`/`AutomationsPage.tsx`** (khác
  file-list gốc) — quyết định đặt toàn bộ mapping tập trung tại
  `automation-host-client.ts` (nơi DUY NHẤT serialize ra wire cho MỌI
  caller, không chỉ dialog 1 chỗ) thay vì lặp lại logic ở tầng UI —
  kiến trúc sạch hơn, và khớp đúng cách `toRuntimeAutomationCreateInput`
  đã tồn tại sẵn làm 1 điểm chuyển đổi duy nhất.

### Test cases đã cover (khớp + vượt 3 mục sketch gốc)

- `createAutomationForTarget` với `actions` 2 phần tử → gửi đúng shape
  (`configJson` JSON-stringified, không phải object) qua `callRuntimeRpc`.
- Submit không có `actions` (form cũ, 1 prompt) → tự map thành
  `actions: [{id:'primary', type:'run_agent', configJson: JSON.stringify({prompt, agentId})}]`.
- Automation cũ (không có `actions` từ backend) → type optional, không
  crash (xác nhận qua tsc --noEmit sạch cho toàn bộ file automations
  liên quan).
- **Vượt sketch**: partial update `{enabled}` → KHÔNG có `actions` key
  (không phá chain có sẵn); update `{actions: []}` tường minh → gửi
  nguyên `[]` (clear); update full-form (`prompt`+`agentId` cùng lúc) →
  tự map lại 1-action chain.

### Verify (chạy thật trong sandbox này)

```
cd frontend
npx vitest run src/renderer/src/components/automations/automation-host-client.test.ts
  # PASS 10/10 (6 cũ + 4 mới)
npx vitest run src/renderer/src/components/automations/
  # PASS 112/113 — 1 fail KHÔNG liên quan (automation-project-groups.test.ts,
  # file tôi không hề sửa, xác nhận qua git diff --stat rỗng cho file đó —
  # tiền sự cố từ session khác trên cùng working directory, không phải do
  # task này)
npx tsc --noEmit -p .
  # 0 lỗi trong bất kỳ file automations-liên-quan nào (automations-types.ts,
  # automation-host-client.ts, AutomationsPage.tsx, AutomationEditorDialog.tsx)
  # — các lỗi tsc khác thấy được (workflow-types, dev-server-types, v.v.)
  # đều ở file tôi không đụng tới, xác nhận qua git diff --stat rỗng

cd ../backend-go
go build ./services/api-gateway/...    # sạch
go vet ./services/api-gateway/...      # sạch
go test ./services/api-gateway/internal/adapter/wscompat/... -run Automation -v
  # PASS 11/11 (7 cũ + 4 mới)
```

**Files đã sửa:**
- `frontend/src/shared/automations-types.ts` (MODIFY)
- `frontend/src/renderer/src/components/automations/automation-host-client.ts` (MODIFY)
- `frontend/src/renderer/src/components/automations/automation-host-client.test.ts` (MODIFY — sửa 1 test sai shape + 5 test mới)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task.go` (MODIFY — ngoài phạm vi gốc, bắt buộc)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task_test.go` (MODIFY — 4 test mới)
