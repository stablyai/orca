# CR-AUTO-001 — Chọn backend canonical cho automation, chấm dứt 3 bản triplicate

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-AUTO-001 |
| **Tên** | Hợp nhất 3 implementation automation song song về 1 backend canonical |
| **Loại** | Kiến trúc (Architecture Decision + Consolidation) |
| **Priority** | **P0** |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — **scope đã thu hẹp đáng kể, xem "Cập nhật 2026-09-09"** |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "rà soát F14 ở frontend và backend-go" |
| **Tác động HLD** | Automation domain, toàn bộ execution path |
| **Tác động Features** | F14 (Automations) — mọi CR khác trong nhóm v4 đều phụ thuộc quyết định này |

---

> **Cập nhật 2026-09-09 (khi viết solution ở `specs/*/crs/v4/automations/solutions/`)
> — kết luận gốc "renderer không bao giờ gọi backend-go" SAI, đã sửa.**
> Đọc thẳng `frontend/src/renderer/src/components/automations/automation-host-client.ts`
> và `frontend/src/renderer/src/runtime/runtime-rpc-client.ts` (không chỉ
> tin lại audit trước) cho thấy: mọi hàm trong `automation-host-client.ts`
> (`listAutomationsForTarget`, `createAutomationForTarget`,
> `runAutomationNowForTarget`, ...) đã có nhánh `target.kind === 'environment'`
> gọi `callRuntimeRpc(target, 'automation.list' | 'automation.create' | ...)`
> — `callRuntimeRpc`'s `'environment'` branch gọi
> `window.api.runtimeEnvironments.call({selector: environmentId, method, params})`,
> **đúng cơ chế `ephemeralVm.*` đã dùng để tới `backend-go`'s wscompat
> gateway** (`channels_automation_task.go` phục vụ đúng 6 method này thật).
> Một comment trong chính file này
> (`automation-host-client.ts:89-92`, "proto3 `repeated` fields marshal
> with `omitempty`...") còn là bằng chứng đường này **đã từng chạy thật và
> từng bắt được 1 bug thật** — không phải đường chết, chưa ai đụng tới.
>
> **Hiểu đúng lại kiến trúc**: đây không phải "3 bản triplicate ngẫu
> nhiên", mà là 2 trục thiết kế hợp lệ chồng lên nhau:
> 1. **Trục deployment target** (loại trừ lẫn nhau, chọn 1 lúc build/chạy):
>    Electron desktop dùng `desktop/src/main/automations/service.ts`; Node
>    "server mode" dùng `backend/src/main/automations/` — cả 2 đều đứng
>    sau `window.api.automations.*` khi `target.kind === 'local'`, chỉ
>    khác implementation nào đứng sau preload bridge tuỳ deployment.
> 2. **Trục pairing** (áp dụng như nhau bất kể trục 1): khi user có
>    `activeRuntimeEnvironmentId` (đã pair với 1 dev server/runtime
>    environment từ xa), MỌI automation CRUD/runNow **đã** route qua
>    `backend-go`'s automation-service — không cần code gì thêm.
>
> **Việc còn thiếu, sau khi hiểu đúng, nhỏ hơn nhiều so với "hợp nhất 3
> bản"**: chỉ còn 1 câu hỏi thật — automation tạo ở `{kind: 'local'}`
> (desktop chưa pair với runtime environment nào) có nên tiếp tục dùng
> scheduler Electron-local, hay cũng nên đẩy sang backend-go? Xem "Giải
> pháp đề xuất (đã thu hẹp)" — khuyến nghị: **giữ nguyên** `{kind: 'local'}`
> dùng scheduler cục bộ (nhất quán với cách `ephemeralVm`/mọi domain khác
> đã thiết kế: local ở lại desktop, remote qua backend-go), không migrate.
> CR này từ "kiến trúc lớn" hạ xuống thành **1 CR xác nhận + đóng 2 gap
> nhỏ** — xem solution FE-AUTO-SOL-001/BE-AUTO-SOL-001 để biết chi tiết.

## Bối cảnh & Vấn đề gốc

F14 hiện có **3 implementation server-side độc lập**, không implementation
nào biết tới 2 cái còn lại:

1. **`desktop/src/main/automations/service.ts`** — `AutomationService`
   chạy trong Electron main process, tick 60 giây
   (`DEFAULT_TICK_MS`, dòng 24), lưu automation bằng file-based `Store`,
   dispatch qua `webContents.send('automations:dispatchRequested', …)`
   tới renderer hoặc `headlessDispatcher` khi headless/server mode. IPC
   surface: `desktop/src/main/runtime/rpc/methods/automations.ts` —
   `automation.list` (150), `.show` (155), `.create` (160), `.update`
   (167), `.delete` (174), `.runNow` (179), `.runs` (184).
2. **`backend/src/main/automations/`** — gần như copy 1:1 logic TS trên,
   nhưng lưu Postgres qua `pg-automation-store.ts`/
   `pg-automation-store-rows.ts`/`pg-automation-store-run-mutations.ts`,
   dùng khi `ORCA_MULTI_USER=1` ("server mode", ADR-021, commit
   `413f5c8da`). Không có `AutomationEventBridge.ts`/
   `WorktreeCleanupService.ts`.
3. **`backend-go/services/automation-service`** — Go, Postgres schema
   riêng (`migrations/0001_init.up.sql`, `0002_scheduler_columns.up.sql`),
   scheduler riêng (`internal/adapter/scheduler/ticker.go`, claim due row
   qua `SELECT ... FOR UPDATE SKIP LOCKED`,
   `internal/adapter/postgres/repository.go`'s `ClaimDue`), thực thi
   bằng cách gọi gRPC thật tới `workflow-service.ExecuteAdHocStep`
   (`internal/adapter/grpcclient/workflow_client.go:41-60`). Có test e2e
   thật chứng minh dispatch hoạt động
   (`run_now_e2e_test.go`, 391 dòng).

Renderer's `AutomationsPage.tsx` (2991 dòng) — nơi user thực sự tạo/xem
automation — đi qua `automation-host-client.ts` →
`frontend/src/renderer/src/runtime/runtime-rpc-client.ts`, và
`callRuntimeRpc` chỉ target `{kind:'local'}` (Electron main, implementation
#1) hoặc `{kind:'environment', environmentId}` (implementation #1 chạy
trên 1 remote runtime environment/SSH host). **Không đường nào trong
renderer gọi tới backend-go's automation-service (#3).** `automation.proto`'s
comment tự ghi rõ lý do #3 tồn tại: "closes TS Gap 3 — automation.runNow
had no working execution path in TS" — nhưng theo
`specs/backend-go/bugs/logic-v1/BUG-AT-02-chay-automation-schedule-partial.md`
và việc `service.ts` có scheduler + dispatch path chạy được cục bộ, tiền
đề đó cần được xác minh lại: implementation #1 dispatch được cục bộ (qua
renderer IPC hoặc headless dispatcher), chỉ là **không chạy khi Electron
app không mở** — đó là gap thật, nhưng khác với "hoàn toàn không chạy
được" mà comment ngụ ý.

**Hệ quả cụ thể của việc 3 bản không liên thông:**
- Bất kỳ action executor mới nào (CR-AUTO-003/004) phải viết 3 lần nếu
  không hợp nhất trước — nhân ba effort, nhân ba khả năng lệch hành vi.
- backend-go's automation-service — bản có scheduler bền vững nhất, phù
  hợp nhất với use case SSH/remote-host (AGENTS.md) — hiện **không có
  user thật nào dùng tới** vì UI không gọi nó.
- 2 model dữ liệu khác nhau hoàn toàn (`Automation` TS: nhiều field rời
  rạc, không `step_type`; `Automation` Go: `step_type`+`step_config_json`,
  tái dùng `workflow-service`'s `StepType` enum) — không có mapping nào
  giữa chúng, nên "hợp nhất" không thể chỉ là đổi endpoint, cần thiết kế
  migration.

## Giải pháp đề xuất

### Bước 1 — Quyết định kiến trúc (không code)

Khuyến nghị: **backend-go là canonical cho automation tạo mới**, vì:
- Scheduler Postgres-backed, always-on — không phụ thuộc Electron app có
  đang mở hay không, đúng yêu cầu SSH/remote-host của AGENTS.md.
- Đã có gRPC server, REST gateway (một phần, xem CR-AUTO-008), wscompat
  channel (`channels_automation_task.go`) — hạ tầng đa giao thức đã tồn
  tại, không cần xây transport mới.
- Delegate thực thi qua `workflow-service.ExecuteAdHocStep` — dùng chung
  hạ tầng execution với các domain khác thay vì tự quản lý agent
  dispatch riêng.

**Không đề xuất big-bang rewrite.** Automation cũ (tạo bằng implementation
#1/#2) tiếp tục chạy nguyên trạng cho tới khi có migration path rõ ràng
(ngoài scope CR này — cần 1 CR/spec riêng nếu team chọn migrate dữ liệu
cũ). CR này chỉ chốt: **automation MỚI đi qua backend-go**, và renderer
cần 1 lớp routing để biết automation nào (cũ, gắn `{kind:'local'/'environment'}`)
đi implementation #1, automation nào (mới) đi backend-go.

### Bước 2 — Renderer routing layer

Mở rộng `automation-host-client.ts` để phân biệt 2 target thay vì giả
định luôn là `runtime-rpc-client.ts`. Cách đơn giản nhất tái dùng pattern
đã có ở nơi khác trong repo (nhiều slice renderer đã phân biệt
`backend-go`-backed resource với `runtime`-backed resource theo 1 cờ
capability/feature flag) — không phát minh cơ chế routing mới, khảo sát
1 ví dụ tương tự đã có (vd. cách `pull-request-generation.ts` chọn
backend-go's `scm-integration-service` thay vì chạy `gh` cục bộ) trước
khi thiết kế chi tiết.

### Bước 3 — Đóng `run-target-resolution.ts:41-50`'s hard block có chủ đích

Block cứng hiện tại chặn mọi automation nhắm remote/runtime-environment
tồn tại vì implementation #1 không có scheduler bền vững cho remote host.
Với backend-go làm canonical, constraint này không còn áp dụng cho
automation mới (backend-go scheduler không quan tâm automation chạy trên
host nào — nó chỉ cần gọi `workflow-service` với đúng target). Việc mở
constraint này cho automation-mới-trên-backend-go là 1 phần của quyết
định CR này, nhưng **không** áp dụng ngược cho automation cũ trên
implementation #1 (giữ nguyên block).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Toàn bộ CR-AUTO-002..008 phụ thuộc quyết định này | Cao | Không CR nào trong nhóm nên bắt đầu code trước khi bước 1 (quyết định kiến trúc) được chốt và ghi lại (update chính README này) |
| Dữ liệu automation cũ trên implementation #1/#2 | Trung bình | CR này KHÔNG bao gồm migration dữ liệu cũ — cần CR/spec riêng nếu quyết định migrate; nếu không migrate, sản phẩm sống với 2 backend song song vô thời hạn (chấp nhận được nếu automation cũ dần được user tạo lại trên backend-go) |
| `run-target-resolution.ts:41-50`'s block nới lỏng sai phạm vi | Trung bình | Phải đảm bảo chỉ automation-trên-backend-go được mở, automation cũ trên implementation #1 giữ nguyên block — cần test phân biệt rõ 2 nhánh |
| Node "server mode" (`backend/`, implementation #2) trở nên dư thừa dần | Thấp | Không xoá ngay trong CR này — chỉ ngừng là đích cho automation mới; xoá hẳn implementation #2 là quyết định riêng, ngoài scope |

## Không thuộc phạm vi CR này

- Migration dữ liệu automation cũ từ implementation #1/#2 sang backend-go
  — cần CR/spec riêng nếu được chọn.
- Xoá hẳn `backend/src/main/automations/` hoặc
  `desktop/src/main/automations/` — không CR nào trong nhóm này đề xuất
  xoá code hiện có đang chạy thật cho user hiện tại.
- Action chain, action executor mới — xem CR-AUTO-002..004, tất cả viết
  trên nền quyết định của CR này.

## Liên quan

- `desktop/src/main/automations/service.ts` (implementation #1)
- `backend/src/main/automations/pg-automation-store.ts` (implementation #2)
- `backend-go/services/automation-service/` (implementation #3, canonical đề xuất)
- `frontend/src/renderer/src/runtime/runtime-rpc-client.ts`,
  `frontend/src/renderer/src/components/automations/automation-host-client.ts`
- `frontend/src/renderer/src/store/slices/pull-request-generation.ts` (ví dụ routing tới backend-go đã có)
- `desktop/src/main/automations/run-target-resolution.ts:41-50`
- `specs/backend-go/tdd/services/automation-service.md`
- [CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md) (phụ thuộc cứng vào CR này)
