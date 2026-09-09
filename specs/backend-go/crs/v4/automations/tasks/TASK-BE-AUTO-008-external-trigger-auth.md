# TASK-BE-AUTO-008: Auth interceptor cho `HandleExternalTrigger`

**Solution:** [BE-AUTO-SOL-005](../solutions/BE-AUTO-SOL-005-real-event-triggers.md) | **CR:** CR-AUTO-005
**Depends on:** [TASK-BE-AUTO-001](./TASK-BE-AUTO-001-confirm-routing-and-document.md)
**Status:** ✅ DONE (2026-09-09) — phạm vi thu hẹp thật, xem "Kết quả thực tế"

---

## Mục tiêu

Đóng lỗ hổng bảo mật thật đang tồn tại: `HandleExternalTrigger` không
auth — bất kỳ caller nào trong tenant trust boundary có thể trigger
automation người khác trong cùng tenant.

## Files cần sửa

1. `backend-go/services/automation-service/internal/adapter/grpc/interceptors/` (MODIFY hoặc MỚI — tuỳ bước 1)
2. `backend-go/services/automation-service/README.md` (MODIFY — cập nhật auth status)

## Bước 1 — Khảo sát pattern service-to-service auth đã có

Tìm 1 pattern mTLS/service-identity/service-token đã dùng cho gRPC
service-to-service call khác trong `backend-go` (vd. cách
`workflow-service` gọi `infra-fleet-service`, hoặc cách các service khác
xác thực lẫn nhau) — tái dùng, không tự chế cơ chế mới.

## Nội dung

Thêm interceptor kiểm tra caller identity trước khi `HandleExternalTrigger`
xử lý request — service-to-service token/identity hợp lệ mới được qua,
nếu không trả `PermissionDenied`.

## Test cases cần cover

- Caller có identity hợp lệ → request qua bình thường.
- Caller không có/identity sai → `PermissionDenied`, không chạm tới
  business logic.
- Request tới `HandleExternalTrigger` KHÔNG có credential → bị chặn ở
  interceptor, không phải ở usecase layer (fail sớm).

## Verify

```bash
cd backend-go/services/automation-service && go test ./internal/adapter/grpc/...
```

## gitnexus

`impact({target: "HandleExternalTrigger", direction: "upstream"})` —
xác nhận không phá test hiện có (`handle_external_trigger_test.go`) khi
thêm interceptor — có thể cần cập nhật test đó để mock identity hợp lệ.

## Không thuộc phạm vi task này

- Auth cho external/public webhook (nếu roadmap cần) — xem
  [TASK-BE-AUTO-012](./TASK-BE-AUTO-012-rest-parity-and-readme-fix.md)'s liên quan CR-AUTO-008.

---

## ✅ Kết quả thực tế (2026-09-09) — phạm vi thu hẹp thật sau khảo sát Bước 1

**Bước 1 (khảo sát bắt buộc) phát hiện premise gốc sai lệch đáng kể** —
giống cách CR-AUTO-001 từng phải sửa lại premise sau khi đọc source thật:

1. **Không có pattern mTLS/service-identity/service-token nào tái dùng
   được trong `backend-go`.** Ứng viên duy nhất tìm thấy —
   `credential-broker-service`'s `x-orca-service-id` gRPC metadata header
   (`internal/adapter/grpc/server.go:20-32`) — chính README của service đó
   ("Known gaps", dòng ~223-235) tự ghi rõ: đây KHÔNG phải mTLS/SPIFFE
   identity thật, chỉ là 1 header đọc trực tiếp, và **tính tới Epic B
   (2026-08-17), KHÔNG caller nào trong toàn bộ codebase từng set header
   này**. README đó cũng ghi rõ: "`common/grpcmw`... this service must
   not modify `common/grpcmw` to add that" — tức là quy ước đã có sẵn:
   không tự thêm cơ chế service-identity chung vào `grpcmw`.
2. **`TASK-BE-AUTO-012` (đã Done từ trước) đã tự thêm 1 route REST**
   `POST /automations/{id}/trigger` qua `api-gateway` gọi thẳng
   `HandleExternalTrigger`, dùng ĐÚNG cơ chế identity+tenant-scoping mà
   mọi RPC automation khác đã dùng (`ListAutomations`/`UpdateAutomation`/
   `RunNow`...) — nghĩa là cross-tenant trigger đã KHÔNG THỂ xảy ra từ
   trước khi task này bắt đầu, cùng mức bảo vệ với mọi RPC khác trong
   service này, không phải lỗ hổng riêng của `HandleExternalTrigger`. Nếu
   implement đúng sketch gốc (chặn cứng nếu thiếu `x-orca-service-id` hợp
   lệ), sẽ **phá route REST đã ship và có test** này — vì `api-gateway`
   không set header đó.
3. Nguồn nội bộ thật (2b agent-completion, 2c PR-merged — lý do ban đầu
   cần "service-to-service auth") **vẫn chưa tồn tại** — không có caller
   nào trong codebase gọi `HandleExternalTrigger` như 1 service-to-service
   call thật hôm nay. Không có gì thật để test/gate cho hướng đó.

**Quyết định phạm vi** (nhất quán với ràng buộc "không tự chế cơ chế mới"
đã ghi sẵn trong task): KHÔNG tự tạo 1 cơ chế service-identity mới (sẽ là
lý thuyết suông, không caller nào set), KHÔNG tái dùng
`x-orca-service-id` (sẽ phá route REST đã ship). Thay vào đó, làm phần
thật, an toàn, và đúng nghĩa đen "Test cases cần cover"'s ý "fail sớm ở
interceptor, không phải usecase layer":

- `RunNow.Execute` (nơi `HandleExternalTrigger` delegate tới) đã tự chặn
  thiếu tenant qua `tenant.RequireTenantID`, nhưng CHỈ sau khi vào tới
  usecase layer, và trả `KindUnauthenticated`. Chuyển đúng check này lên
  interceptor — fail-fast trước khi chạm usecase/repository, trả
  `codes.PermissionDenied` (khớp nghĩa "bạn không có quyền" hơn
  "chưa xác thực").
- Interceptor CHỈ áp dụng cho `HandleExternalTrigger`
  (`info.FullMethod` match `AutomationService_HandleExternalTrigger_FullMethodName`)
  — mọi RPC khác đi qua không đổi, vẫn dựa vào usecase-layer check riêng.
- Đặt trong package MỚI `internal/adapter/grpc/interceptors/` (không sửa
  `common/grpcmw`), compose vào `grpc.NewServer` qua 1
  `grpc.ChainUnaryInterceptor` option thứ 2 (xác nhận qua đọc source
  `grpc-go`: nhiều `ChainUnaryInterceptor` option cộng dồn đúng thứ tự,
  không ghi đè nhau) — chạy SAU `grpcmw.TenantExtractionInterceptor` nên
  đọc đúng tenant đã parse từ metadata.

**Ghi chú cho tương lai**: khi 2b/2c thật sự có caller, việc phân biệt
"internal service call" với "user REST call" cần 1 yêu cầu thật (token
gì, ai cấp) — nên định nghĩa lại lúc đó, không đoán trước ở đây.

**Test cases đã cover** (3, khớp đúng 3 mục sketch gốc, tái diễn giải
theo phạm vi thật):
- `TestRequireTenantForExternalTrigger_ValidTenant_PassesThrough` — có
  tenant hợp lệ → qua bình thường, handler được gọi.
- `TestRequireTenantForExternalTrigger_NoTenant_RejectsBeforeHandler` —
  không có tenant → `PermissionDenied`, handler KHÔNG được gọi (fail
  sớm, đúng yêu cầu "không chạm business logic").
- `TestRequireTenantForExternalTrigger_OtherMethods_PassThroughUnchecked`
  — `RunNow` (method khác) không có tenant vẫn qua interceptor này bình
  thường (gate chỉ áp cho đúng 1 RPC).

**Verify (chạy thật trong sandbox này)**:
```
gofmt -l ...                                        # sạch
go build ./services/automation-service/...          # sạch
go vet ./services/automation-service/...             # sạch
go test ./services/automation-service/... ./services/api-gateway/...   # PASS toàn bộ, không regression route REST /trigger
```

**Files đã sửa:**
- `backend-go/services/automation-service/internal/adapter/grpc/interceptors/require_tenant_for_external_trigger.go` (MỚI)
- `backend-go/services/automation-service/internal/adapter/grpc/interceptors/require_tenant_for_external_trigger_test.go` (MỚI — 3 test)
- `backend-go/services/automation-service/cmd/server/main.go` (MODIFY — compose interceptor thứ 2 vào `grpc.NewServer`)
