# CR-AUTO-008 — backend-go REST parity + auth cho external trigger + fix README lỗi thời

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-AUTO-008 |
| **Tên** | Thêm REST route còn thiếu, đóng lỗ hổng auth `HandleExternalTrigger`, sửa README tự mâu thuẫn với code |
| **Loại** | Bug Fix / Security |
| **Priority** | P2 (scope hẹp/nhanh — không phải vì ít nghiêm trọng, xem "Rủi ro chung" ở README) |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "rà soát F14 ở frontend và backend-go" |
| **Tác động HLD** | Automation domain, API gateway |
| **Tác động Features** | F14 (Automations) |

---

## Bối cảnh & Vấn đề gốc

### 1. REST route thiếu

`backend-go/services/api-gateway/internal/adapter/httpgateway/automation_routes.go:23-28`
chỉ mount:
```
POST   /v1/automations/
POST   /v1/automations/{id}/run
GET    /v1/automations/{id}/runs
POST   /v1/automations/{id}/trigger
```
`ListAutomations`/`UpdateAutomation`/`DeleteAutomation` — dù đã có gRPC
server implementation thật (`server.go:115,131,171`) — **không có REST
route nào**, chỉ gọi được qua gRPC trực tiếp hoặc wscompat
(`channels_automation_task.go`). Bất kỳ client nào chỉ nói REST (không
qua wscompat/gRPC) không list/update/delete được automation qua backend-go.

### 2. Auth gap ở `HandleExternalTrigger`

`backend-go/services/automation-service/README.md:174-179` tự ghi nhận:
`payload_json` được chấp nhận nhưng không xác thực; bất kỳ caller nào
trong tenant trust boundary hiện tại có thể fire external trigger của
automation người khác **trong cùng tenant**. Đây là gap bảo mật thật
đang tồn tại, không phải rủi ro lý thuyết.

### 3. README tự mâu thuẫn với code

`backend-go/services/automation-service/README.md:188` viết: "No
UpdateAutomation/DeleteAutomation/GetAutomation/ListAutomations RPCs.
Still absent from the generated proto." — sai với thực tế:
`automation.proto:27-29` và `server.go` (dòng 115, 131, 171) đã implement
`ListAutomations`/`UpdateAutomation`/`DeleteAutomation` từ commit
`3df9da8b1` (2026-08-25). README cuối cùng sửa ở `0e7092d18`
(2026-08-18) — **trước** thời điểm đó, chưa từng update lại. Chỉ
`GetAutomation` (single-automation fetch by id) thật sự vẫn thiếu.

## Giải pháp đề xuất

### REST route mới

Thêm vào `automation_routes.go`, theo đúng convention REST đã dùng cho 4
route hiện có (cùng file, cùng middleware/tenant-scoping pattern):
```
GET    /v1/automations/            → ListAutomations
PATCH  /v1/automations/{id}        → UpdateAutomation
DELETE /v1/automations/{id}        → DeleteAutomation
```
Không đổi shape request/response so với gRPC message tương ứng — REST
route chỉ là 1 lớp mỏng map HTTP → gRPC call thật (giống 4 route hiện có
đã làm).

### Auth cho `HandleExternalTrigger`

Thêm xác thực theo 1 trong 2 hướng (cần quyết định trước khi code, tương
tự cách CR-EVM-005 để ngỏ Option A/B cho SSH):
- **Option A — shared secret per-automation**: khi tạo automation có
  external trigger, sinh 1 secret ngẫu nhiên, lưu hash; caller gửi
  kèm `X-Automation-Trigger-Secret` header hoặc HMAC signature theo
  payload — đúng mô hình webhook secret phổ biến (GitHub/GitLab webhook
  đều theo mô hình này, nhất quán với AGENTS.md's "Git Provider
  Compatibility" tinh thần không lệch chuẩn ngành).
- **Option B — service-to-service token nội bộ**: nếu `HandleExternalTrigger`
  chỉ thật sự cần gọi từ nguồn nội bộ (agent, scm-integration-service —
  xem [CR-AUTO-005](./CR-AUTO-005-real-event-triggers.md)'s bước 4), có
  thể chỉ cần xác thực bằng service token nội bộ đã có sẵn trong repo
  (không public-facing) — khảo sát nếu 1 pattern service-to-service auth
  đã tồn tại trong `backend-go`, tái dùng thay vì tạo mới.

Khuyến nghị: **cả 2**, không loại trừ nhau — Option B cho nguồn nội bộ
(CR-AUTO-005), Option A cho nguồn thật sự bên ngoài (nếu roadmap có kế
hoạch public webhook, vd. GitHub webhook trực tiếp gọi automation mà
không qua scm-integration-service trung gian).

### Sửa README

Cập nhật `backend-go/services/automation-service/README.md:174-179,188`
khớp thực tế: 6/7 RPC đã implement (chỉ thiếu `GetAutomation`), auth
status theo đúng những gì CR này để lại (nếu chỉ làm Option B, ghi rõ
"external trigger chỉ chấp nhận caller nội bộ đã auth, chưa hỗ trợ
webhook công khai").

### `GetAutomation` (phát hiện phụ, không có trong 5 CR ban đầu)

Nếu `ListAutomations` không đủ hiệu quả cho 1 số client cần fetch theo
id (thay vì list rồi filter), thêm luôn RPC `GetAutomation` + REST route
tương ứng trong CR này — chi phí nhỏ, cùng nhóm thay đổi REST parity.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Auth gap đang tồn tại thật hôm nay, không phải rủi ro tương lai | Cao (mức độ), nhưng scope hẹp | Ưu tiên làm sớm dù priority ghi P2 — xem README's "Rủi ro chung" |
| REST route mới cần đúng tenant-scoping như 4 route hiện có | Trung bình | Copy sai middleware/scoping có thể mở lỗ hổng cross-tenant mới — review kỹ theo đúng pattern đã có, không tự viết middleware mới |
| Chọn sai Option A/B cho auth có thể phải làm lại | Trung bình | Quyết định trước khi code, không code song song cả 2 rồi chọn sau |

## Không thuộc phạm vi CR này

- Circular-trigger detection (BR-AT-04) — xem CR-AUTO-005.
- Public webhook endpoint đầy đủ (nếu roadmap thật sự cần GitHub/GitLab
  gọi thẳng vào automation mà không qua scm-integration-service) — CR
  này chỉ đóng gap auth cho `HandleExternalTrigger` hiện có, không thiết
  kế webhook endpoint mới hoàn toàn.

## Liên quan

- `backend-go/services/api-gateway/internal/adapter/httpgateway/automation_routes.go:23-28`
- `backend-go/services/automation-service/internal/adapter/grpc/server.go:115,131,171`
- `backend-go/proto/orca/automation/v1/automation.proto:20-25,27-29`
- `backend-go/services/automation-service/README.md:174-179,188` (cần sửa)
- [CR-AUTO-005](./CR-AUTO-005-real-event-triggers.md) (nguồn caller nội bộ cho `HandleExternalTrigger`)
