# CR-RBAC-006 — Policy admin sửa xong phải có hiệu lực thật (bỏ NoopPublisher)

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-RBAC-006 |
| **Tên** | Wire `AccessPolicy` CRUD → OPA bundle thật (thay `policypublisher.NoopPublisher`) |
| **Loại** | Bug Fix (stub chưa hoàn thiện) |
| **Priority** | 🟠 P1 — về mặt UX/vận hành đây là "silent no-op" nguy hiểm: admin tin là đã áp policy nhưng thực ra chưa | 
| **Effort** | Medium–Large (3–5 ngày, tuỳ chọn hot-reload hay restart-based) |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Chưa triển khai |
| **Tác giả** | Rà soát backend-go OPA/policy theo yêu cầu hoàn thiện F32 |
| **Tác động HLD** | C3.1 |
| **Tác động Features** | F32 |
| **Phụ thuộc** | Không — nhưng là điều kiện tiên quyết để CR-RBAC-001 gộp `PoliciesPage` (Hệ B) vào `AccessPolicy` RPC (Hệ A) có ý nghĩa thật |

---

## Bối cảnh & Vấn đề

- Enforcement thật của backend-go là OPA đánh giá bundle Rego tĩnh, nạp 1 lần lúc process khởi động và cache lại (`backend-go/common/policy/evaluator.go`'s `Evaluator.Warm`, comment tự nhận: *"a policy edit requires a service restart — no hot reload"*).
- `auth-service` đã có đủ RPC quản trị policy (`CreateAccessPolicy`/`GetAccessPolicy`/`ListAccessPolicies`/`UpdateAccessPolicy`/`DeleteAccessPolicy`, `access_policy.go`) — lưu 1 **document JSON có version**, có vẻ như thiết kế để publish vào bundle OPA đang chạy.
- Nhưng bước publish thật là **no-op**: `update_access_policy.go:56-65` gọi qua `PolicyDataPublisher` interface, implementation hiện tại là `policypublisher.NoopPublisher` — tức là admin gọi `UpdateAccessPolicy` thành công (HTTP 200, version tăng, audit log ghi nhận) nhưng **không có gì thay đổi trong hành vi enforcement thật** của hệ thống.
- Đây là gap nguy hiểm nhất trong toàn bộ RBAC stack: khác với các gap khác (chưa làm, rõ ràng là "thiếu"), gap này **trông như đã hoạt động** (API trả về thành công) trong khi thực chất là ảo giác — admin có thể tưởng đã khoá quyền truy cập nhưng chính sách cũ vẫn đang chạy.

## Giải pháp đề xuất

Chọn 1 trong 2 hướng (khuyến nghị hướng 1 cho MVP, hướng 2 nếu cần policy có hiệu lực tức thời — production security-sensitive nên ưu tiên hướng 2 dài hạn):

### Hướng 1 — Publish vào file bundle + reload theo tín hiệu (đơn giản hơn)
1. `PolicyDataPublisher` thật: mỗi lần `CreateAccessPolicy`/`UpdateAccessPolicy`/`DeleteAccessPolicy` thành công, ghi `document_json` (đã validate là Rego data hợp lệ) ra file trong thư mục bundle mà `Evaluator` đang trỏ tới.
2. Thêm cơ chế reload: hoặc (a) health-check/cron nội bộ mỗi N giây gọi lại `rego.Load` nếu file đổi (so mtime/hash), hoặc (b) 1 RPC/internal signal `ReloadPolicyBundle` mà `UpdateAccessPolicy` gọi ngay sau khi ghi file — ưu tiên (b) để có hiệu lực tức thời thay vì chờ polling.
3. Validate chặt: nếu policy JSON mới không compile được trong OPA (`rego.Load` lỗi), **từ chối cả write** (không cho `UpdateAccessPolicy` thành công) — tránh 1 bundle hỏng làm sập enforcement toàn hệ thống.

### Hướng 2 — OPA bundle server / bundle API thật (theo đúng mô hình OPA khuyến nghị)
- Chạy OPA như bundle server (hoặc dùng OPA's Bundle API) thay vì nạp file tĩnh — `Evaluator` poll bundle server định kỳ (built-in OPA feature). `AccessPolicy` CRUD ghi vào storage mà bundle server đọc (S3/GCS/local dir tuỳ hạ tầng hiện có).
- Effort lớn hơn hướng 1 nhưng đúng chuẩn OPA, hỗ trợ multi-instance auth-service (bundle poll không cần signal nội bộ giữa các instance).

## Changes Required

| File | Thay đổi |
|------|---------|
| `backend-go/services/auth-service/internal/adapter/policypublisher/publisher.go` | Thay `NoopPublisher` bằng implementation thật (chọn hướng ở trên) |
| `backend-go/common/policy/evaluator.go` | Thêm cơ chế reload (nếu hướng 1b) hoặc chuyển sang bundle-server client (hướng 2) |
| `backend-go/services/auth-service/internal/usecase/update_access_policy.go`, `create_access_policy.go`, `delete_access_policy.go` | Validate compile trước khi chấp nhận write; gọi reload sau khi publish thành công |
| Deploy | Nếu hướng 2: hạ tầng lưu bundle (S3/GCS/volume) + cấu hình OPA bundle polling |

## Không thuộc phạm vi CR này

- Đổi định dạng `document_json` hiện tại thành khớp 100% với F32's resource×action matrix cũ — CR này chỉ đảm bảo *policy admin viết ra có hiệu lực thật*, không đổi hình dạng dữ liệu (việc đó, nếu cần, là 1 CR UX/DX riêng cho form nhập policy — hiện `document_json` đã đủ generic để biểu diễn Rego data cho mọi rule).

## Tiêu chí chấp nhận

- [ ] Sau `UpdateAccessPolicy`, 1 request enforcement thực tế (không cần restart process) phản ánh đúng policy mới trong vòng thời gian xác định (tức thời nếu hướng 1b/2, hoặc trong X giây nếu polling).
- [ ] Policy document không compile được → write bị từ chối, không làm hỏng bundle đang chạy.
- [ ] Test tích hợp: update policy → gọi 1 RPC bị policy đó chặn → xác nhận bị chặn **không cần restart service** trong lúc test.

## Impact analysis (gitnexus)

| Symbol | Direction | Risk | Impacted |
|---|---|---|---|
| `NoopPublisher` (`auth-service/internal/adapter/policypublisher/publisher.go`) | upstream | LOW | 3 (1 direct, ảnh hưởng process `run` ở `auth-service/cmd/server/main.go`) |

## Liên quan

- [F32-team-rbac.md](../../../features/F32-team-rbac.md)
- CR-RBAC-001 (Admin UI Policies tab chỉ nên cutover sau khi CR này xong)
