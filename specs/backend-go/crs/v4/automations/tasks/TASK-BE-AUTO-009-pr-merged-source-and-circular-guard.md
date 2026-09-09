# TASK-BE-AUTO-009: Nối nguồn PR-merged + circular-trigger guard

**Solution:** [BE-AUTO-SOL-005](../solutions/BE-AUTO-SOL-005-real-event-triggers.md) | **CR:** CR-AUTO-005
**Depends on:** [TASK-BE-AUTO-008](./TASK-BE-AUTO-008-external-trigger-auth.md)
**Status:** ⛔ BLOCKED (2026-09-09) — Bước 1 xác nhận scope lớn hơn 1 task, xem "Kết quả khảo sát"

---

## Mục tiêu

`scm-integration-service` gọi `HandleExternalTrigger` khi phát hiện PR
merged; thêm guard chặn vòng lặp trigger vô hạn (BR-AT-04).

## Files cần sửa

1. `backend-go/services/scm-integration-service/...` (MODIFY — điểm gọi, tuỳ bước 1)
2. `backend-go/services/automation-service/internal/usecase/handle_external_trigger.go` (MODIFY — thêm circular guard)
3. Test tương ứng

## Bước 1 — Khảo sát cơ chế phát hiện PR merged đã có

`scm-integration-service` đã nhận webhook hay polling status cho PR
hiện tại chưa (dùng cho mục đích khác, vd. cập nhật UI PR status)? Nếu
có, tái dùng điểm đó, thêm 1 lời gọi `HandleExternalTrigger` (service-to-
service, dùng auth từ TASK-BE-AUTO-008). Nếu chưa có cơ chế nào — báo
cáo, đây là scope lớn hơn dự kiến, không tự ý thêm webhook receiver mới
trong task này.

## Bước 2 — Circular-trigger guard

Trước khi dispatch trong `handle_external_trigger.go`: giới hạn độ sâu
chain trigger (vd. field `trigger_depth` trên `RunNowRequest`/context,
tăng dần qua mỗi lần external-trigger gọi tiếp — automation's action
`create_pr`/`commit_push` không tự động mang `trigger_depth` này trừ khi
cố tình thiết kế truyền qua, cần xác nhận thiết kế truyền context này
trước khi code). Giới hạn đề xuất: tối đa 3 lớp liên tiếp — vượt quá →
log warning + không dispatch (không lỗi cứng, tránh false positive chặn
use case hợp lệ).

## Test cases cần cover

- PR merged (giả lập nguồn từ bước 1) → `HandleExternalTrigger` được
  gọi với đúng `request_id`/payload.
- Chain trigger sâu quá giới hạn → bị chặn, có log, không panic.
- Chain trigger trong giới hạn → chạy bình thường.

## Verify

```bash
cd backend-go/services/automation-service && go test ./internal/usecase/...
cd ../scm-integration-service && go test ./...
```

## gitnexus

`impact({target: "HandleExternalTrigger", direction: "downstream"})`
trước khi thêm guard — xác nhận không phá flow hiện có.

---

## ⛔ Kết quả khảo sát (2026-09-09) — Bước 1 xác nhận scope lớn hơn dự kiến

**Khảo sát thật** (`grep` toàn bộ `scm-integration-service`, đọc
`proto/orca/scmintegration/v1/scmintegration.proto`'s danh sách RPC):
`scm-integration-service` hiện chỉ có RPC dạng request/response do
**client trong hệ thống chủ động gọi** (`ListPullRequests`,
`GetPullRequestForBranch`, `MergePullRequest` — cái này là app CHỦ ĐỘNG
merge, không phải phát hiện merge từ bên ngoài, v.v.). **Không có webhook
receiver, không có polling scheduler, không có bất kỳ cơ chế phát hiện
sự kiện "PR merged" nào tồn tại** — xác nhận đúng nghi ngờ xấu nhất của
task's Bước 1.

**Theo đúng hướng dẫn tự ghi sẵn trong task này** ("Nếu chưa có cơ chế
nào — báo cáo, đây là scope lớn hơn dự kiến, không tự ý thêm webhook
receiver mới trong task này"): KHÔNG tự thêm webhook ingress endpoint
hoặc polling scheduler mới ở đây. Xây 1 trong 2 cơ chế đó là khối lượng
công việc riêng (xác thực chữ ký webhook, route HTTP mới, hoặc vòng lặp
poll + dedup + lưu trạng thái "đã thấy") — không phù hợp làm "tiện thể"
trong 1 task vốn chỉ dự kiến "nối 1 lời gọi vào điểm đã có sẵn".

**Bước 2 (circular-trigger guard) cũng phụ thuộc trực tiếp vào Bước 1**:
task's chính sketch tự ghi "cần xác nhận thiết kế truyền `trigger_depth`
context này trước khi code" — 1 câu hỏi thiết kế còn mở, và không có gì
thật để guard chống lại khi chưa có bất kỳ caller `HandleExternalTrigger`
service-to-service nào tồn tại (`TASK-BE-AUTO-008`'s khảo sát đã xác
nhận: 0 caller thật hôm nay). Viết guard cho 1 chain-trigger scenario
chưa từng xảy ra được là suy đoán trước thiết kế, không phải implement
theo yêu cầu thật.

**Quyết định**: để task này ở trạng thái BLOCKED, không tự ý mở rộng
scope hoặc suy đoán thiết kế. Cần 1 quyết định sản phẩm/kiến trúc riêng
(giống pattern `FE-TASK-EVM-007`/`TASK-AG-EVM-012` trong CR khác của
phiên làm việc này) trước khi có task code thật:
1. Chọn cơ chế phát hiện PR-merged (webhook hay polling) — ước lượng lại
   effort đúng quy mô (không phải 1 task nhỏ).
2. Thiết kế cách `trigger_depth` truyền qua chain (từ automation A's
   `create_pr` action → PR merged event → automation B's
   `HandleExternalTrigger` call — action's `config_json` hiện không có
   chỗ nào mang theo "tôi được trigger từ automation nào, độ sâu bao
   nhiêu").

**Không có code nào được sửa cho task này** — đúng tinh thần "báo cáo,
không tự chế" mà task's Bước 1 đã yêu cầu sẵn.
