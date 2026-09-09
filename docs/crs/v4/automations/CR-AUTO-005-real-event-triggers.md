# CR-AUTO-005 — Event trigger thật, thay `AutomationEventBridge.ts` chết

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-AUTO-005 |
| **Tên** | Xoá `AutomationEventBridge.ts` (dead code), xây event trigger thật trên `backend-go`'s `HandleExternalTrigger` |
| **Loại** | Bug Fix (capability gap tưởng đã fix nhưng chưa) + Feature |
| **Priority** | P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "rà soát F14 ở frontend và backend-go" |
| **Tác động HLD** | Automation domain, event bus nội bộ |
| **Tác động Features** | F14 (Automations) — Event trigger type |

---

## Bối cảnh & Vấn đề gốc

F14's spec liệt kê **Event** là 1 trong 3 loại trigger ("khi agent kết
thúc, khi PR merged" —
[`docs/features/F14-automations.md:37`](../../../features/F14-automations.md)).
`specs/backend/bugs/automation/BUG-BE-AT-001-event-based-automation-not-implemented.md`
claim việc này **✅ FIXED** qua `desktop/src/main/automations/AutomationEventBridge.ts`.
Audit trực tiếp (2026-09-09) xác nhận claim đó **sai**:

1. **Không nơi nào trong sản phẩm khởi tạo class này.**
   `grep -rn "new AutomationEventBridge"` toàn repo chỉ khớp chính
   doc-comment ví dụ trong file (`AutomationEventBridge.ts:13`,
   `/**\n *   const bridge = new AutomationEventBridge(automationService, eventBus)\n */`) —
   không composition-root, không service registration nào thật gọi
   constructor này.
2. **Nếu có ai gọi, code sẽ throw runtime.** Dòng 145 gọi
   `this.automationService.dispatchAutomation(automation.id, …)` —
   `AutomationService` (`service.ts`) không có method `dispatchAutomation`
   nào (chỉ có `runNow`, `runPrecheck`, `markDispatchResult`, và các
   private `evaluateDueRuns`/`evaluateAutomation`/`requestDispatch`).
3. **Đọc field không tồn tại trên type thật.** Dòng 140 đọc
   `a.triggerType` qua cast `as unknown as {...}` (dòng 132-134) — nhưng
   `Automation` (`automations-types.ts`) không có field `triggerType`
   nào; `AutomationRunTrigger = 'scheduled' | 'manual'` (dòng 18) —
   không có giá trị `'event'`.

`AutomationRunTrigger` hiện tại **không thể** biểu diễn 1 run được kích
hoạt bởi event — chain lỗi bắt đầu từ type model, không chỉ ở bridge.

## Giải pháp đề xuất

### Bước 1 — Đánh dấu/xoá dead code

Xoá `AutomationEventBridge.ts` khỏi `desktop/src/main/automations/`
(hoặc archive dưới `docs/backlog/` nếu team muốn giữ tham chiếu thiết kế)
— không để nguyên trạng "trông như đã fix" gây hiểu lầm cho lần audit
sau. Đồng thời sửa
`specs/backend/bugs/automation/BUG-BE-AT-001-event-based-automation-not-implemented.md`'s
status về đúng thực tế (chưa fix), trỏ sang CR này.

### Bước 2 — Mở rộng `AutomationRunTrigger`

```ts
// frontend/src/shared/automations-types.ts
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'external'
```

Dùng `'external'` (khớp thuật ngữ `HandleExternalTrigger` đã có ở
backend-go) thay vì `'event'`, để 1 thuật ngữ xuyên suốt toàn hệ thống —
tránh 2 tên gọi cho cùng 1 khái niệm.

### Bước 3 — Event trigger thật trên nền `backend-go`'s `HandleExternalTrigger`

**Phụ thuộc mềm vào [CR-AUTO-001](./CR-AUTO-001-consolidate-execution-backend.md)**
(cần biết automation nào chạy trên backend-go mới có `HandleExternalTrigger`
để gọi) — nhưng có giá trị độc lập với action chain (CR-AUTO-002): 1
automation 1-step vẫn hưởng lợi từ trigger event thật.

`HandleExternalTrigger` (`automation.proto:20-25`) đã là RPC thật, có
idempotency qua `request_id` (map vào `automation_runs`'s
`(tenant_id, request_id)` unique index) — đúng nguyên liệu cần. Việc còn
thiếu là **nối các sự kiện nội bộ vào nó**:

```
Nơi phát sự kiện thật                          → gọi HandleExternalTrigger với
─────────────────────────────────────────────────────────────────────────────
agent run hoàn thành (agent.exec kết thúc,      → request_id = `${runId}:agent_finished`
  đã có sự kiện nội bộ ở đâu đó trong           
  desktop/agent — khảo sát trước khi build,      
  không tự thêm event bus mới nếu đã có)
PR merged (webhook GitHub/GitLab đã nhận        → request_id = `${prId}:merged`,
  ở scm-integration-service, hoặc polling         nguồn: sự kiện provider-agnostic
  status hiện có)                                 đã có ở scm-integration-service
```

Khảo sát bắt buộc trước khi code: tìm sự kiện "agent run hoàn thành" và
"PR merged" đã tồn tại ở đâu trong hệ thống hiện tại (nhiều khả năng đã
có cho mục đích khác — vd. thông báo UI, task-graph status) — tái dùng
nguồn phát sự kiện đó, không tạo event bus song song mới giống lỗi thiết
kế của `AutomationEventBridge.ts` (file đó tự định nghĩa
`EventEmitter`-based `eventBus` riêng, không rõ ai emit vào đó).

### Bước 4 — Đóng lỗ hổng auth (bắt buộc trước khi mở rộng nguồn trigger)

`backend-go/services/automation-service/README.md:174-179` tự nhận:
`HandleExternalTrigger`'s `payload_json` được chấp nhận nhưng không xác
thực — "any caller inside the existing tenant trust boundary can fire
external triggers". Trước khi nối thêm nguồn trigger nội bộ (bước 3),
cần xác nhận nguồn gọi vào cũng nằm trong tenant trust boundary hợp lệ —
xem [CR-AUTO-008](./CR-AUTO-008-backend-go-rest-parity-webhook-auth.md)
cho phần đóng gap auth tổng thể (webhook bên ngoài); CR này chỉ cần đảm
bảo caller nội bộ (agent/scm-integration-service) xác thực đúng cách
tương đương service-to-service hiện có trong repo (mTLS/service token nội
bộ nếu đã có pattern, không tự chế cơ chế mới).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Chưa xác định nguồn phát sự kiện "agent hoàn thành"/"PR merged" đã tồn tại chưa | Trung bình | Cần 1 vòng khảo sát riêng trước khi code — nếu chưa có, CR này phình to hơn dự kiến (phải thêm cả event source) |
| Vòng lặp trigger (automation A tạo PR → PR merged trigger automation B → …) | Trung bình | `specs/backend-go/bugs/logic-v1/BUG-AT-01-cau-hinh-automation-partial.md`'s BR-AT-04 (circular-trigger detection) chưa implement — nên làm cùng CR này nếu event trigger được bật thật, tránh loop vô hạn |
| Đóng gap auth chậm hơn mở event source | Cao | Thứ tự bước 4 PHẢI trước hoặc cùng lúc bước 3 — không mở thêm nguồn gọi `HandleExternalTrigger` khi auth gap còn tồn tại |
| `specs/backend/bugs/automation/BUG-BE-AT-001-...md`'s status sai lan truyền sang tài liệu khác | Thấp | Sửa cả `docs/guides/task-automation/task-automation-orchestration-integration.md` nếu nó cũng trích dẫn status "đã fix" này |

## Không thuộc phạm vi CR này

- Circular-trigger detection đầy đủ (BR-AT-04) — nêu như rủi ro cần theo
  dõi, nhưng implement đầy đủ có thể tách CR riêng nếu scope lớn hơn dự
  kiến sau khảo sát bước 3.
- Webhook auth cho caller **bên ngoài** tenant (public webhook endpoint
  nếu sản phẩm cần) — xem CR-AUTO-008.

## Liên quan

- `desktop/src/main/automations/AutomationEventBridge.ts` (dead code, đề xuất xoá)
- `frontend/src/shared/automations-types.ts:18` (`AutomationRunTrigger`)
- `backend-go/proto/orca/automation/v1/automation.proto:20-25` (`HandleExternalTrigger`)
- `backend-go/services/automation-service/README.md:174-179` (auth gap tự nhận)
- `specs/backend/bugs/automation/BUG-BE-AT-001-event-based-automation-not-implemented.md` (status cần sửa)
- `specs/backend-go/bugs/logic-v1/BUG-AT-01-cau-hinh-automation-partial.md` (BR-AT-04, circular-trigger)
- [CR-AUTO-001](./CR-AUTO-001-consolidate-execution-backend.md) (phụ thuộc mềm)
- [CR-AUTO-008](./CR-AUTO-008-backend-go-rest-parity-webhook-auth.md) (đóng gap auth tổng thể)
