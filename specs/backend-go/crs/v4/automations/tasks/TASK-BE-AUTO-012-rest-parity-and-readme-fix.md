# TASK-BE-AUTO-012: REST route List/Update/Delete/Get + sửa README lỗi thời

**Solution:** [BE-AUTO-SOL-007](../solutions/BE-AUTO-SOL-007-rest-parity-webhook-auth.md) | **CR:** CR-AUTO-008
**Depends on:** Không
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Thêm REST route còn thiếu (map thẳng vào gRPC đã có), thêm `GetAutomation`
nếu cần, sửa README tự mâu thuẫn với code.

## Files cần sửa

1. `backend-go/services/api-gateway/internal/adapter/httpgateway/automation_routes.go` (MODIFY)
2. `backend-go/proto/orca/automation/v1/automation.proto` (MODIFY — thêm `GetAutomation` RPC, NẾU quyết định cần — xem bước 1)
3. `backend-go/services/automation-service/internal/adapter/grpc/server.go` (MODIFY — implement `GetAutomation`, nếu thêm)
4. `backend-go/services/automation-service/README.md` (MODIFY — sửa dòng 174-179, 188)
5. Test tương ứng

## Bước 1 — Quyết định có cần `GetAutomation` không

Xác nhận `ListAutomations` (đã có) có đủ dùng cho mọi client hiện tại
(fetch-by-id giả lập bằng list + filter phía client) hay thật sự cần
fetch-by-id ở server. Nếu không rõ nhu cầu thật, **bỏ qua `GetAutomation`
trong task này** (không thêm RPC không ai cần), chỉ làm 3 route còn lại.

## Nội dung

```go
// automation_routes.go, copy middleware/tenant-scoping từ 4 route hiện có
router.GET("/v1/automations/", h.listAutomations)
router.PATCH("/v1/automations/{id}", h.updateAutomation)
router.DELETE("/v1/automations/{id}", h.deleteAutomation)
```

Sửa `README.md:174-179` (auth status — trỏ sang
[TASK-BE-AUTO-008](./TASK-BE-AUTO-008-external-trigger-auth.md) nếu đã
làm, nếu chưa ghi rõ "chưa auth, xem CR-AUTO-005") và dòng 188 (sửa số
RPC đã implement thật: 6/7 hoặc 7/7 tuỳ bước 1).

## Test cases cần cover

- `GET /v1/automations/` → trả đúng list, đúng tenant-scoping (test
  cross-tenant KHÔNG thấy automation tenant khác).
- `PATCH`/`DELETE /v1/automations/{id}` → map đúng gRPC, đúng tenant-scoping.
- Route mới không lộ automation của tenant khác (test bảo mật cụ thể,
  không chỉ happy path).

## Verify

```bash
cd backend-go/services/api-gateway && go test ./internal/adapter/httpgateway/...
```

## gitnexus

`impact({target: "ListAutomations", direction: "upstream"})` — xác nhận
route REST mới không trùng lặp/xung đột middleware với route gRPC/wscompat
đã có cho cùng RPC.

---

## ✅ Kết quả thực tế (2026-09-09)

Bước 1: quyết định **không thêm `GetAutomation`** — không có nhu cầu
thật nào xác nhận (chỉ `ListAutomations` đủ dùng hôm nay), ghi rõ lý do
vào README thay vì thêm RPC không ai cần.

3 route mới copy đúng middleware/tenant-scoping pattern từ 4 route hiện
có (`identityFromContext` + `gatewaygrpc.AttachIdentity`, `tenant_id`
luôn từ `identity.TenantID`, không bao giờ từ body/query param —
test `TestHandleListAutomations_SuccessRoundTrip`/
`TestHandleUpdateAutomation_PartialEditOnlySetsProvidedFields` xác nhận
cụ thể điều này, theo đúng convention `TenantIDComesFromIdentityNotBody`
đã có ở test `CreateAutomation`).

`UpdateAutomationRequest` dùng proto3 wrapper type
(`google.protobuf.StringValue`/`BoolValue`) cho semantics "chỉ sửa field
có mặt trong body" — dùng `*string`/`*bool` (Go pointer) ở REST body
struct để phân biệt "field vắng mặt" (nil → không set wrapper → không
đổi) với "field có giá trị" — test
`TestHandleUpdateAutomation_PartialEditOnlySetsProvidedFields` xác nhận
gửi chỉ `{"enabled":false}` thì `Name`/`Rrule` wrapper vẫn `nil` phía
gRPC request.

**Phát hiện phụ khi implement**: file test's comment (viết trước khi
task này chạy) đã tự trích "TASK-218's List/Update/Delete" như 1 việc
dự kiến — xác nhận task này không phải phát minh mới, mà hoàn thành 1
phần đã được thiết kế từ trước.

**Verify**: `go build ./services/api-gateway/...` — sạch. `go vet
./services/api-gateway/internal/adapter/httpgateway/...` — phát hiện 1
lỗi thật (`t.Fatalf copies lock value` — truyền `got` protobuf struct
theo value vào `Fatalf`, chứa `sync.Mutex` nội bộ của protobuf runtime)
— đã sửa (`&got`). `go test ./services/api-gateway/internal/adapter/httpgateway/...`
— toàn bộ package pass (không riêng automation, cả package — không phá
gì).

**Files đã sửa:**
- `backend-go/services/api-gateway/internal/adapter/httpgateway/automation_routes.go` (MODIFY)
- `backend-go/services/api-gateway/internal/adapter/httpgateway/automation_routes_test.go` (MODIFY — thêm fake client methods + 5 test)
- `backend-go/services/automation-service/README.md` (MODIFY — sửa 2 đoạn lỗi thời)
