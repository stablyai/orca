# TASK-BE-AUTO-003: Postgres migration — `actions_json`/`action_results_json`

**Solution:** [BE-AUTO-SOL-002](../solutions/BE-AUTO-SOL-002-multi-action-chain-data-model.md) | **CR:** CR-AUTO-002
**Depends on:** [TASK-BE-AUTO-002](./TASK-BE-AUTO-002-proto-action-chain.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Thêm cột JSONB cho `actions`/`action_results` — dùng JSONB (không bảng
con), nhất quán với cách `step_config_json` hiện tại đã lưu.

## Files cần sửa

1. `backend-go/services/automation-service/migrations/0003_action_chain.up.sql` (MỚI)
2. `backend-go/services/automation-service/migrations/0003_action_chain.down.sql` (MỚI)
3. `backend-go/services/automation-service/internal/adapter/postgres/repository.go` (MODIFY — đọc/ghi 2 cột mới)

## Nội dung

```sql
-- 0003_action_chain.up.sql
ALTER TABLE automations ADD COLUMN actions_json JSONB NOT NULL DEFAULT '[]';
ALTER TABLE automation_runs ADD COLUMN action_results_json JSONB NOT NULL DEFAULT '[]';
```
```sql
-- 0003_action_chain.down.sql
ALTER TABLE automation_runs DROP COLUMN action_results_json;
ALTER TABLE automations DROP COLUMN actions_json;
```

**Trước khi tạo file này**: kiểm tra xem TASK-BE-AUTO-010/011 (Track 6,
cũng ALTER 2 bảng này) có đang được implement gần cùng lúc không — nếu
có, gộp thành 1 migration file duy nhất theo đúng khuyến nghị ở
`tasks/README.md`.

## Test cases cần cover

- Migration up/down chạy sạch trên DB test (theo đúng harness migration
  test đã có cho `0001`/`0002`, tái dùng không viết mới).
- `repository.go`'s read/write round-trip cho `actions_json`.

## Verify

```bash
cd backend-go/services/automation-service && go test ./internal/adapter/postgres/...
```

## gitnexus

`impact({target: "repository.go", direction: "downstream"})` trước khi
sửa — xác nhận usecase nào gọi các hàm read/write bị ảnh hưởng.

---

## ✅ Kết quả thực tế (2026-09-09)

**Mở rộng phạm vi có chủ đích**: gộp cả cột của TASK-BE-AUTO-011
(`running_run_id`, `running_since`) vào migration `0003` này — đúng
khuyến nghị "gộp migration nếu gần nhau" của chính README, tránh 3 lần
ALTER TABLE riêng lẻ (003/010/011) trên cùng 2 bảng.

**Domain layer**: KHÔNG đổi `NewAutomation`'s signature (giữ nguyên tính
tương thích ngược, đúng tinh thần "ít thay đổi code nhất") — `Actions`/
`MaxRunHistory`/`RunTimeoutSeconds` là field export thêm mới, gán trực
tiếp sau khi constructor trả về, theo đúng pattern đã có sẵn cho
`NextRunAt` (comment gốc: "Advanced by internal/adapter/scheduler after
each dispatch" — tức gán field trực tiếp ngoài constructor đã là
convention tồn tại từ trước, không phải tôi tự bịa).

**Repository layer**: `actions_json`/`action_results_json` lưu JSONB
(không bảng con), (de)serialize qua `actionRow`/`actionResultRow` (JSON
tag snake_case khớp tên field trong `automation.proto`). Mọi method đọc
(`Get`/`List`/`ClaimDue`/`FindByRequestID`/`ListByAutomation`) và ghi
(`Create`/`Update`/`UpdateStatus`) đều cập nhật đủ cột mới.

**Verify (test tích hợp thật, không phải giả định)**: Docker sẵn có
trong môi trường — chạy `go test -tags=integration
./services/automation-service/internal/adapter/postgres/...` thật (không
chỉ compile-check) qua testcontainers-go, Postgres 16 thật: **9/9 test
pass** (2 lần đầu fail vì "database system is starting up" — race
condition khởi động container của testcontainers, không phải lỗi migration/
code; chạy lại riêng 2 test đó pass sạch, xác nhận là flake môi trường
không phải bug thật). `go build`/`go test` (unit, không cần Docker) cho
toàn bộ `automation-service` — sạch.

**Files đã sửa/tạo:**
- `backend-go/services/automation-service/migrations/0003_action_chain.up.sql` (MỚI)
- `backend-go/services/automation-service/migrations/0003_action_chain.down.sql` (MỚI)
- `backend-go/services/automation-service/internal/domain/automation.go` (MODIFY)
- `backend-go/services/automation-service/internal/domain/automation_run.go` (MODIFY)
- `backend-go/services/automation-service/internal/adapter/postgres/repository.go` (MODIFY)
