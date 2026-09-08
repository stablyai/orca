# TASK-BE-EVM-010: `EphemeralVmRuntime` response shape lệch frontend — phát hiện mới từ FE-TASK-EVM-001

**Solution:** Không có solution gốc — phát hiện trong lúc thực thi [FE-TASK-EVM-001](../../../../frontend/crs/v3/ephemeral-vm/tasks/FE-TASK-EVM-001-remove-stale-suppressor-and-routing-audit.md)'s audit field-by-field (2026-09-08), ngoài phạm vi mọi CR ban đầu.
**Service:** `infra-fleet-service` (`toEphemeralVmRuntimeView`) + `api-gateway`
**Depends on:** Không
**Status:** ✅ DONE (2026-09-08)

> **Kết quả thực tế:**
> - **Audit lại từ đầu (không tin "Files cần sửa" của task doc)** — đọc trực
>   tiếp `domain.EphemeralVmRuntime` (dòng 14-25: `CreatedAt`/`UpdatedAt`
>   CÓ SẴN, xác nhận đúng như ghi chú), `infrafleet.proto`'s
>   `EphemeralVmRuntime` message (dòng 215-226: `created_at`/`updated_at`
>   đã có ở field 9/10, và `toProtoEphemeralVmRuntime`
>   (`server_ephemeral_vm.go:29`) đã map đủ 2 field này vào proto — chỉ
>   riêng `toEphemeralVmRuntimeView` ở api-gateway chưa map vào view JSON),
>   và frontend's `EphemeralVmRuntimeRecordSchema` thật
>   (`frontend/src/shared/ephemeral-vm-runtimes.ts:34-52`). Xác nhận đúng
>   5 lệch FE-TASK-EVM-001 đã tìm: thiếu `createdAt`/`updatedAt`/
>   `cleanupStatus`/`recipeResult`, lệch tên `connectionType`↔`connectionMode`
>   và `environmentId`↔`runtimeEnvironmentId`, lệch vocabulary `status`.
>   Tự viết round-trip test frontend (Zod `safeParse` thật, không giả định)
>   phát hiện thêm 1 lệch **KHÔNG có trong audit gốc**: `workspaceId`/
>   `lastError` được BE gửi luôn dạng `""` khi chưa gán, nhưng
>   `workspaceId` phía FE là `z.string().min(1).optional()` — chuỗi rỗng
>   fail `min(1)`, không phải "thiếu key" mà là "key có nhưng giá trị vi
>   phạm validation". Đã sửa cùng lúc.
> - **Quyết định cuối cho từng field** (không giả định, đọc code thật
>   trước khi quyết):
>   1. `createdAt`/`updatedAt` — **ADD** vào `toEphemeralVmRuntimeView`,
>      convert `*timestamppb.Timestamp` → epoch millis (`AsTime().UnixMilli()`)
>      khớp `z.number().finite()`. Dữ liệu thật 100%, không có gì phải
>      quyết định.
>   2. `connectionType`→`connectionMode`, `environmentId`→
>      `runtimeEnvironmentId` — **RENAME** key trong response map (không
>      đổi phía backend domain/proto, chỉ đổi tên khi serialize view).
>      Backend để trống (`""`) 2 field này tới khi pairing/attach xong —
>      **omit key thay vì gửi `""`** (khớp `.optional()` phía FE).
>   3. `status` vocabulary (BE 5 giá trị vs FE 9 giá trị) — audit
>      `ephemeral_vm_relay.go` xác nhận: `"destroyed"` chỉ đạt được qua
>      `CleanupWorkspace` thành công (dòng 170), `"error"` được set bởi CẢ
>      3 nhánh suspend/resume/cleanup lỗi (dòng 103/128/166) — không phân
>      biệt được nguồn gốc. Quyết định: **map an toàn, không bịa**:
>      `provisioning`→`provisioning`, `active`→`running`,
>      `suspended`→`suspended`, `destroyed`→`cleaned` (đồng nghĩa thật),
>      `error`→`failed` (dùng đúng bucket "lỗi chung" có sẵn trong FE
>      enum, không đoán cụ thể là suspend_failed/resume_failed/
>      cleanup_failed vì BE không track đủ chi tiết để biết).
>   4. `cleanupStatus`/`recipeResult` — **quyết định cuối: KHÔNG bịa dữ
>      liệu ở backend cho phần lõi, nới lỏng Zod schema phía frontend
>      thành optional**, ngoại trừ 1 case an toàn:
>      - `cleanupStatus`: chỉ set `"succeeded"` khi `status == "destroyed"`
>        (an toàn 100%, xem mục 3). Mọi status khác: **để trống** (không
>        default về `"not_started"` — vì 1 lần cleanup thất bại thật sự có
>        thể lẫn vào `"error"`, default `"not_started"` sẽ che giấu lỗi
>        thật).
>      - `recipeResult`: **không thể suy ra** — `domain.EphemeralVmRuntime`
>        không lưu `pairingCode`/`projectRoot`/`sshTarget` cho từng runtime
>        (khác desktop-local's file store, nơi field này luôn có vì lưu
>        trực tiếp kết quả script). Bịa ra sẽ hiển thị sai lệch nguy hiểm
>        (project root/pairing code giả).
>      - Đổi `EphemeralVmRuntimeRecordSchema.cleanupStatus`/`.recipeResult`
>        thành `.optional()` — **đã audit blast radius trước khi đổi**:
>        `cleanupStatus` chỉ dùng qua so sánh `===` ở
>        `EphemeralVmRuntimesSection.tsx` (an toàn với `undefined`);
>        `recipeResult` có 2 call site gọi
>        `getEphemeralVmRecipeResultProjectRoot()` không qua guard
>        (`EphemeralVmRuntimesSection.tsx:269` và
>        `ephemeral-vm-workspace-target.ts:83`) — cả 2 đã thêm guard
>        tường minh (component: fallback ẩn phần project-root khi thiếu;
>        workspace-target: coi thiếu `recipeResult` ngay sau
>        `provision()` là lỗi thật, trả `ok:false` — path này luôn có dữ
>        liệu thật từ desktop-local flow nên guard chỉ là an toàn phòng
>        thủ, không đổi hành vi thực tế).
> - **Không đụng file `channels_ephemeral_vm.go`'s phần provision** — đọc
>   lại file ngay trước khi sửa (2 lần, cách nhau ~30 phút giữa các bước
>   sửa), xác nhận agent kia (TASK-BE-EVM-005) chưa thêm channel
>   `provision`/`cancelProvision`/`onProvisionEvent` vào file này tại thời
>   điểm audit — chỉ sửa đúng `toEphemeralVmRuntimeView` + helper mới
>   (`ephemeralVmFrontendStatus`, `ephemeralVmRuntimeTimestampMillis`).
> - **gitnexus**: `impact({target: "toEphemeralVmRuntimeView",
>   direction: "upstream", repo: "orca"})` — 2 lần thử đều lỗi: lần 1
>   "multiple repositories indexed" (thiếu `repo`), lần 2 (đã thêm
>   `repo: "orca"`) "LadybugDB unavailable... another process may be
>   rebuilding the index" (index đang bị khoá — nhất quán với agent kia
>   đang chạy song song trên backend-go). Không dùng được; thay vào đó
>   xác nhận thủ công qua `grep`: cả 5 call site
>   (`listRuntimes`/`attachWorkspace`/`suspendWorkspace`/`resumeWorkspace`/
>   `cleanup`) đều gọi `toEphemeralVmRuntimeView` không có logic khác đọc
>   field theo tên cũ (`connectionType`/`environmentId`) — an toàn đổi
>   tên. Không tìm thấy risk HIGH/CRITICAL nào cần cảnh báo.
> - **Test thật đã chạy**:
>   - Backend-go: `cd backend-go/services/api-gateway && go build ./... &&
>     go test ./internal/adapter/wscompat/... -run EphemeralVm` → **15/15
>     PASS** (11 test cũ không đổi hành vi + 4 test mới:
>     `TestToEphemeralVmRuntimeView_IncludesAllFrontendRequiredFields`,
>     `_DestroyedStatus_SetsCleanupStatusSucceeded`,
>     `_MapsStatusToFrontendVocabulary`, `_EmptyOptionalStrings_OmitsKeys`).
>     `go build ./...` toàn bộ `backend-go` (từng service module) — OK.
>   - Frontend: `cd frontend && npx vitest run --config
>     config/vitest.config.ts src/shared/ephemeral-vm-runtimes.test.ts
>     src/shared/ephemeral-vm-runtime-store.test.ts
>     src/renderer/src/lib/ephemeral-vm-workspace-target.test.ts
>     src/renderer/src/lib/ephemeral-vm-workspace-target.integration.test.ts
>     src/renderer/src/lib/ephemeral-vm-runtime-cleanup.test.ts
>     src/renderer/src/components/settings/EphemeralVmRuntimesSection.test.tsx
>     src/renderer/src/runtime/desktop-only-rpc-error-suppressor.test.ts
>     src/renderer/src/runtime/runtime-ephemeral-vm-client.test.ts` →
>     **45/45 pass, 1 todo** (test mới:
>     `ephemeral-vm-runtimes.test.ts`, round-trip `safeParse` với fixture
>     khớp đúng response thật của `toEphemeralVmRuntimeView`, 3 case:
>     đầy đủ field, never-attached/pre-pairing, destroyed). `npx tsc
>     --noEmit` → 0 lỗi type mới liên quan tới ephemeral-vm (baseline
>     ~113-142 dòng lỗi không liên quan, đã xác nhận qua grep không có
>     dòng nào chứa "ephemeral" trước và sau thay đổi).
> - **Gap còn lại, không tự ý mở rộng phạm vi** (ghi rõ để không lặp lại
>   audit): `cleanupStatus` vẫn `undefined` cho mọi status khác
>   `"destroyed"` (kể cả `"error"` — có thể là cleanup thất bại thật);
>   `recipeResult` luôn `undefined` cho runtime backend-go (không có
>   pairing code/project root hiển thị được ở Settings UI cho nhóm
>   runtime này). Cần: (a) backend-go lưu thêm cleanup sub-state +
>   recipe/connection result thật (migration + relay logic mới), hoặc
>   (b) tách `EphemeralVmRuntimeRecord` thành union/variant theo nguồn
>   gốc (desktop-local vs infra-fleet-service) — cả 2 đều là task riêng,
>   ngoài phạm vi "sửa response shape" của task này.

---

## Vấn đề (nguồn: FE-TASK-EVM-001's audit thật, không suy đoán)

`channels_ephemeral_vm.go`'s `toEphemeralVmRuntimeView` (dùng cho
`attachWorkspace`/`suspendWorkspace`/`resumeWorkspace`/`cleanup`/
`listRuntimes`) chỉ trả **8 field**, trong khi frontend's Zod schema
`EphemeralVmRuntimeRecord` (dùng bởi `EphemeralVmRuntimesSection.tsx` để
sort/hiển thị badge) **yêu cầu bắt buộc** nhiều hơn:

- **4 field required phía frontend, KHÔNG tồn tại phía backend-go**:
  `cleanupStatus`, `createdAt`, `updatedAt`, `recipeResult`.
- **2 field lệch tên** (cùng ý nghĩa, tên khác): `connectionType` (BE) ↔
  `connectionMode` (FE); `environmentId` (BE) ↔ `runtimeEnvironmentId` (FE).
- **`status` lệch vocabulary** — không có ánh xạ 1-1 an toàn giữa 2 tập
  giá trị (BE: `"provisioning"|"active"|"suspended"|"error"|"destroyed"`
  — xem `ephemeral_vm_runtime.go:19` — vs giá trị frontend Zod schema
  chấp nhận).

FE-TASK-EVM-001 KHÔNG tự sửa vấn đề này (ngoài phạm vi 2 file được giao
cho task đó, và sửa phía frontend một mình sẽ phải fabricate dữ liệu
không có thật ở backend — vi phạm nguyên tắc không bịa dữ liệu).

## Mục tiêu

Mở rộng `domain.EphemeralVmRuntime`/Postgres schema/`toEphemeralVmRuntimeView`
để trả đủ field frontend cần, HOẶC (nếu 1 số field như `createdAt`/
`updatedAt`/`recipeResult` đã có trong domain struct nhưng chỉ chưa được
map vào view — audit trước khi giả định cần schema mới) đơn giản là bổ
sung mapping còn thiếu.

## Files cần sửa (xác nhận lại sau audit — chưa chắc chắn 100% vì chưa tự đọc source cho task này)

1. `backend-go/services/infra-fleet-service/internal/domain/ephemeral_vm_runtime.go` — audit xem `CreatedAt`/`UpdatedAt` đã có field chưa (theo BE-SOL-EVM-001 đã xác nhận struct có `CreatedAt time.Time`/`UpdatedAt time.Time` ở dòng 23-24 — CÓ SẴN, chỉ thiếu map vào view/proto)
2. `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go` (MODIFY — `toEphemeralVmRuntimeView`, thêm field còn thiếu, đổi tên `connectionType`→giữ nguyên hay đổi theo FE, quyết định hướng đổi ở bước audit)
3. `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (MODIFY nếu `EphemeralVmRuntime` message thiếu field tương ứng — đối chiếu `EphemeralVmRuntime` message hiện có, dòng 207-, đã có `created_at`/`updated_at` — audit xem đã map đủ chưa)
4. `cleanupStatus`/`recipeResult` — có thể KHÔNG tồn tại ở backend-go domain model nào cả (khác `createdAt`/`updatedAt`) — cần quyết định: thêm field mới (migration) hay đây là field UI-only cần bỏ khỏi frontend Zod schema thay vì thêm backend. **Đây là quyết định cần audit kỹ trước khi code, không giả định hướng nào.**

## Test cases cần cover

- Round-trip test: response thật từ `toEphemeralVmRuntimeView` decode được bởi frontend's `EphemeralVmRuntimeRecord` Zod schema không lỗi (test nên đặt ở cả 2 phía, hoặc 1 test chia sẻ fixture JSON).
- `TestToEphemeralVmRuntimeView_IncludesAllFrontendRequiredFields`

## Verify

```bash
cd backend-go/services/api-gateway && go build ./... && go test ./internal/adapter/wscompat/... -run EphemeralVm
```

## gitnexus

`impact({target: "toEphemeralVmRuntimeView", direction: "upstream"})`
trước khi đổi shape — xác nhận mọi call site (`attachWorkspace`/
`suspendWorkspace`/`resumeWorkspace`/`cleanup`/`listRuntimes`, cả 5 đều
dùng chung hàm này) không vỡ khi đổi field.

## Blocking

Không task ephemeral-vm nào khác phụ thuộc cứng — nhưng
`EphemeralVmRuntimesSection.tsx` (frontend, ngoài phạm vi nhóm task này)
đang hiển thị sai/thiếu dữ liệu cho tới khi task này xong. Nên đưa vào
backlog thực thi sớm, không để treo vô thời hạn.
