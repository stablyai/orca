# BE-AUTO-SOL-007: REST parity + webhook auth + fix README lỗi thời

> **🔲 Designed — chưa implement.** Độc lập, không phụ thuộc solution
> nào khác trong nhóm — an toàn để làm sớm.

**CR:** [CR-AUTO-008](../../../../../../docs/crs/v4/automations/CR-AUTO-008-backend-go-rest-parity-webhook-auth.md)
**Service:** `automation-service`, `api-gateway`
**TDD tham chiếu:** [`api-gateway.md`](../../../../tdd/services/api-gateway.md)

---

## 1. Trạng thái hiện tại

`automation_routes.go:23-28` chỉ mount 4/7 khả năng REST. gRPC server đã
có đủ `ListAutomations`/`UpdateAutomation`/`DeleteAutomation`
(`server.go:115,131,171`) — chỉ thiếu route HTTP, không thiếu logic.
`README.md:188` nói sai (đã sửa nhận thức ở CR level).

## 2. Giải pháp

### REST route mới — map thẳng vào gRPC đã có

```go
// automation_routes.go, cùng khuôn 4 route hiện có
router.GET("/v1/automations/", h.listAutomations)      // → ListAutomations
router.PATCH("/v1/automations/{id}", h.updateAutomation) // → UpdateAutomation
router.DELETE("/v1/automations/{id}", h.deleteAutomation) // → DeleteAutomation
```
Middleware/tenant-scoping copy nguyên xi từ route hiện có (không viết
middleware mới) — review kỹ để không mở lỗ hổng cross-tenant khi copy.

### `GetAutomation` (phát hiện phụ)

Thêm RPC + REST nếu client cần fetch theo id thay vì list — chi phí nhỏ,
làm cùng đợt REST parity này.

### Auth cho `HandleExternalTrigger`

Xem [BE-AUTO-SOL-005](./BE-AUTO-SOL-005-real-event-triggers.md) mục 2a —
solution đó implement auth; solution này chỉ đảm bảo route REST
`/trigger` (đã có, `automation_routes.go:23-28`) đi qua đúng middleware
mới sau khi 005 ship (không cần đổi gì ở route nếu middleware áp dụng
đúng tầng gRPC interceptor — chỉ cần verify route REST cũng đi qua cùng
interceptor).

### Sửa README

Cập nhật `README.md:174-179,188` khớp thực tế: 6/7 RPC đã có (chỉ thiếu
`GetAutomation` cho tới khi mục "GetAutomation" ở trên ship, sau đó là
7/7), auth status theo đúng những gì BE-AUTO-SOL-005 để lại.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Copy sai middleware/tenant-scoping | Trung bình | Review kỹ theo pattern đã có, đây là điểm dễ tạo lỗ hổng bảo mật mới nhất trong solution này |
| Auth cho `/trigger` route phụ thuộc BE-AUTO-SOL-005 | Thấp | REST route bản thân không chặn — chỉ cần đảm bảo interceptor áp dụng đúng khi 005 ship, không cần đợi 005 xong mới làm REST parity |

## Không thuộc phạm vi solution này

- Auth logic cho `HandleExternalTrigger` — xem BE-AUTO-SOL-005.
- Public webhook endpoint mới hoàn toàn (nếu roadmap cần) — không có
  trong scope CR-AUTO-008 gốc.

## Liên quan

- `backend-go/services/api-gateway/internal/adapter/httpgateway/automation_routes.go:23-28`
- `backend-go/services/automation-service/internal/adapter/grpc/server.go:115,131,171`
- `backend-go/services/automation-service/README.md:174-179,188`
- [BE-AUTO-SOL-005](./BE-AUTO-SOL-005-real-event-triggers.md) (auth logic dùng chung)
