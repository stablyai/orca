# BE-AUTO-SOL-005: `HandleExternalTrigger` — nối nguồn thật + auth

> **🔲 Designed — chưa implement.**

**CR:** [CR-AUTO-005](../../../../../../docs/crs/v4/automations/CR-AUTO-005-real-event-triggers.md)
**Frontend counterpart:** [FE-AUTO-SOL-005](../../../../frontend/crs/v4/automation/solutions/FE-AUTO-SOL-005-real-event-triggers.md)
**Service:** `automation-service`
**TDD tham chiếu:** [`automation-service.md`](../../../../tdd/services/automation-service.md)

---

## 1. Trạng thái hiện tại

`HandleExternalTrigger` (`automation.proto:20-25`) đã thật, có
idempotency qua `request_id`. `README.md:174-179` tự nhận: không auth.
Không nguồn nội bộ nào (agent hoàn thành, PR merged) gọi vào nó — chỉ
tồn tại như 1 entry point chờ caller.

## 2. Giải pháp

### 2a. Auth trước (bắt buộc trước 2b — xem CR-AUTO-005's "Rủi ro")

Thêm interceptor/middleware kiểm tra caller cho `HandleExternalTrigger`,
2 lớp:
- **Service-to-service** (cho nguồn nội bộ mục 2b): dùng service token
  nội bộ đã có pattern trong `backend-go` (khảo sát
  `internal/adapter/grpc/interceptors/` hoặc tương đương trước khi tự chế
  cơ chế mới — nếu 1 pattern mTLS/service-identity đã tồn tại cho gRPC
  service-to-service call khác trong repo, tái dùng).
- **External** (webhook thật, nếu roadmap cần) — xem
  [BE-AUTO-SOL-007](./BE-AUTO-SOL-007-rest-parity-webhook-auth.md), CR
  riêng, không lẫn vào đây.

### 2b. Nối nguồn "agent run hoàn thành"

**Khảo sát bắt buộc trước khi code** (theo đúng CR-AUTO-005's Bước 1):
tín hiệu gần nhất tìm được là `AgentDetector`
(`desktop/src/main/stats/agent-detector.ts`) — theo dõi working→idle
transition per-PTY qua OSC title, dùng cho usage stats hôm nay, **không
phải** 1 khái niệm "task hoàn thành" chính thức. Đây là tín hiệu ở
**Electron main process** (frontend domain), không phải backend-go — vì
vậy việc "gọi `HandleExternalTrigger`" khi agent xong việc phải xuất
phát từ phía frontend/desktop (qua 1 RPC gọi vào backend-go), không phải
backend-go tự phát hiện. Xem
[FE-AUTO-SOL-005](../../../../frontend/crs/v4/automation/solutions/FE-AUTO-SOL-005-real-event-triggers.md)
cho phần đó — solution này (backend-go) chỉ cần đảm bảo
`HandleExternalTrigger` sẵn sàng nhận đúng caller đó sau khi auth (2a)
xong.

### 2c. Nối nguồn "PR merged"

`scm-integration-service` (backend-go, đã tồn tại) là nơi hợp lý nhất
phát sự kiện này (nó đã nói chuyện với GitHub/GitLab API/webhook thật)
— thêm 1 lời gọi `HandleExternalTrigger` từ `scm-integration-service`
khi phát hiện PR merged (qua webhook đã nhận, hoặc polling status hiện
có — khảo sát cơ chế nào `scm-integration-service` đã dùng cho mục đích
khác trước khi thêm). Đây là gọi service-to-service nội bộ (dùng auth
lớp 2a's service-to-service, không phải external).

### 2d. Circular-trigger detection (BR-AT-04, đóng cùng lúc nếu scope cho phép)

Trước khi dispatch từ `HandleExternalTrigger`, kiểm tra: automation A's
run history có action `create_pr`/`commit_push` gần đây trỏ tới đúng
PR/branch đang trigger automation B không, và B có action nào lại trigger
A không (đơn giản nhất: giới hạn độ sâu chain trigger — vd. tối đa 3 lớp
external-trigger liên tiếp trong 1 "trigger lineage" — không cần graph
detection đầy đủ cho v1).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| 2a phải xong trước 2b/2c | Cao | Không mở thêm caller khi auth gap còn tồn tại (đúng CR-AUTO-005's cảnh báo) |
| Vòng lặp trigger vô hạn nếu bỏ qua 2d | Trung bình | Nên làm cùng lúc, không hoãn |
| `scm-integration-service` có cơ chế phát hiện PR-merged sẵn có hay cần thêm | Chưa xác nhận | Cần khảo sát trước khi ước lượng effort 2c chính xác |

## Không thuộc phạm vi solution này

- Public webhook endpoint cho caller bên ngoài — xem BE-AUTO-SOL-007.
- Tín hiệu "agent hoàn thành" phía frontend/desktop — xem FE-AUTO-SOL-005.

## Liên quan

- `backend-go/proto/orca/automation/v1/automation.proto:20-25`
- `backend-go/services/automation-service/README.md:174-179`
- `desktop/src/main/stats/agent-detector.ts` (tín hiệu ứng viên, phía frontend)
- `backend-go/services/scm-integration-service`
- `specs/backend-go/bugs/logic-v1/BUG-AT-01-cau-hinh-automation-partial.md` (BR-AT-04)
