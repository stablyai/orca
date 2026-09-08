# TASK-BE-STORAGE-001: Migration — 6 cột JSON mới + bảng `user_workspace_sessions`

**Solution:** BE-SOL-STORAGE-001 | **CRs:** CR-STORAGE-001, CR-STORAGE-003, CR-STORAGE-004(a,b)
**Service:** `tenant-service`
**Depends on:** Không
**Status:** ✅ DONE (2026-09-07)

> **Kết quả thực tế:** Migration `0006_client_state_and_workspace_sessions.{up,down}.sql`
> (đánh số 0006, không phải `XXXX` như doc gốc — 0001-0005 đã tồn tại) chạy
> **thật** trên container Postgres thật `orca-go-postgres` (network
> `orca-go_orca-go-net`, DB `tenant`) — không phải chỉ testcontainers giả lập:
> `migrate ... up` (0001→0006), rồi `down 1`, rồi `up` lại — cả 3 lần chạy
> sạch, không lỗi. Xác nhận bằng query trực tiếp: `information_schema.columns`
> cho thấy đủ 5 cột mới trên `tenant.user_profiles`
> (`keybindings_json`/`ui_local_state_json`/`saved_runtime_environments_json`/
> `client_settings_json`/`accounts_dev_server_json`); `pg_class.relrowsecurity`
> = `true` và `pg_policy` cho thấy đúng policy
> `company_id = current_setting('app.tenant_id', true)::uuid` trên
> `tenant.user_workspace_sessions`, giống hệt pattern 4 bảng RLS hiện có ở
> `0001_init.up.sql`. **Khác biệt duy nhất so với thiết kế gốc**: chỉ 5 cột
> JSON được thêm vào `user_profiles` (không phải 6) — `workspace_session_json`
> đúng như BE-SOL-STORAGE-001 §3 đã ghi rõ, đi vào bảng riêng
> `user_workspace_sessions`, không phải cột thứ 6 trên `user_profiles` (tiêu
> đề file task này ghi "6 cột" hơi gây nhầm lẫn — nội dung thật của task luôn
> là 5 cột + 1 bảng, xem mục "Nội dung migration" bên dưới).

---

## Mục tiêu

Thêm schema cần thiết cho toàn bộ nhóm CR "preference cá nhân" — additive
only, không đổi cột/bảng hiện có.

## Files cần sửa

1. `backend-go/services/tenant-service/migrations/XXXX_user_profile_client_state.up.sql` (MỚI)
2. `backend-go/services/tenant-service/migrations/XXXX_user_profile_client_state.down.sql` (MỚI)

## Nội dung migration

```sql
-- up
ALTER TABLE tenant.user_profiles
  ADD COLUMN keybindings_json                TEXT NULL,
  ADD COLUMN ui_local_state_json             TEXT NULL,
  ADD COLUMN saved_runtime_environments_json TEXT NULL,
  ADD COLUMN client_settings_json            TEXT NULL,
  ADD COLUMN accounts_dev_server_json        TEXT NULL;

CREATE TABLE tenant.user_workspace_sessions (
  user_id      UUID NOT NULL,
  company_id   UUID NOT NULL,
  host_id      TEXT NOT NULL,
  session_json TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, host_id)
);
CREATE INDEX idx_user_workspace_sessions_company ON tenant.user_workspace_sessions(company_id);
ALTER TABLE tenant.user_workspace_sessions ENABLE ROW LEVEL SECURITY;
-- RLS policy: current_setting('app.tenant_id') = company_id::text, cùng pattern
-- 4 bảng RLS hiện có trong tenant-service.md §5 — copy đúng policy hiện dùng
-- cho departments/user_profiles, chỉ đổi tên bảng.
```

```sql
-- down
DROP TABLE IF EXISTS tenant.user_workspace_sessions;
ALTER TABLE tenant.user_profiles
  DROP COLUMN IF EXISTS keybindings_json,
  DROP COLUMN IF EXISTS ui_local_state_json,
  DROP COLUMN IF EXISTS saved_runtime_environments_json,
  DROP COLUMN IF EXISTS client_settings_json,
  DROP COLUMN IF EXISTS accounts_dev_server_json;
```

**Lưu ý**: `workspace_session_json` KHÔNG nằm trong `user_profiles` — nó có
bảng riêng vì cần khoá thêm theo `host_id` (xem BE-SOL-STORAGE-001 §3).
5 cột còn lại đi vào `user_profiles` như bình thường.

## Test cases cần cover

- Migration `up` chạy sạch trên schema hiện tại (không có `user_profiles`
  row nào bị NULL constraint vi phạm — cả 5 cột đều `NULL`-able).
- Migration `down` xoá sạch, chạy lại `up` sau `down` không lỗi.
- RLS policy trên `user_workspace_sessions` — company A không đọc được row
  của company B (test bằng 2 `current_setting('app.tenant_id')` khác nhau).

## Verify

```bash
cd backend-go/services/tenant-service && make migrate-up && make migrate-down && make migrate-up
# hoặc lệnh migration tool thực tế repo đang dùng (xác nhận trong Makefile/README service)
```

## gitnexus

Không áp dụng — đây là migration SQL thuần, không có symbol code để chạy
`impact()`. Chạy `detect_changes({scope: "compare", base_ref: "main"})` sau
khi hoàn tất TASK-BE-STORAGE-001..004 (toàn bộ BE-SOL-STORAGE-001) để xác
nhận scope thay đổi đúng dự kiến.

## Blocking

TASK-BE-STORAGE-002 (repository methods) phụ thuộc cột/bảng ở đây tồn tại.
