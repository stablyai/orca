# TASK-BE-STORAGE-006: RPC `GetFleetConnectivitySummary` (infra-fleet-service)

**Solution:** BE-SOL-STORAGE-002 | **CR:** CR-STORAGE-007
**Service:** `infra-fleet-service`
**Depends on:** Không
**Status:** ✅ DONE — 2026-09-07

---

**Kết quả thực tế:** Implement đúng như thiết kế BE-SOL-STORAGE-002 §3.

- `proto/orca/infrafleet/v1/infrafleet.proto`: thêm `GetFleetConnectivitySummaryRequest`
  (rỗng), `ConnectionHealthEntry`, `GetFleetConnectivitySummaryResponse`, và
  RPC `GetFleetConnectivitySummary`. `buf generate` chạy sạch — chỉ
  `infrafleet.pb.go`/`infrafleet_grpc.pb.go` thay đổi (2 service khác —
  `tenant`, `scmintegration`, `gitgateway` — có proto nguồn đã bị agent
  khác sửa uncommitted trong cùng repo dùng chung; generated code của họ bị
  regenerate ngoài ý muốn khi chạy `buf generate` toàn repo, đã revert lại
  về `git checkout` để diff chỉ còn infrafleet).
- `internal/usecase/get_fleet_connectivity_summary.go` (MỚI): usecase đọc
  `tenant.RequireTenantID(ctx)` rồi gọi `FleetConnectivityRepository.ListConnectivitySummary`
  — port mới, tách riêng khỏi `ConnectionRepository` (cùng lý do
  `FleetHealthPollerRepository` đã tách). Trả `[]domain.Connection{}` rỗng
  (không nil) khi không có connection nào.
- `internal/adapter/postgres/repository.go` (MODIFY): thêm
  `ListConnectivitySummary` — `SELECT ... FROM infra.connections c JOIN
  infra.dev_servers d ON d.id = c.dev_server_id AND d.tenant_id = c.tenant_id
  WHERE c.tenant_id = $1`, join qua `dev_servers` làm defense-in-depth tenant
  scoping đúng yêu cầu task.
- `internal/adapter/grpc/server.go` (MODIFY): thêm handler
  `GetFleetConnectivitySummary` + `toProtoConnectionHealthEntry` (map
  `LastActivityAt`/`DegradedSince` sang `*timestamppb.Timestamp`, giữ `nil`
  khi domain field `nil` — không fabricate timestamp giả).
- `cmd/server/main.go` (MODIFY): wire `usecase.NewGetFleetConnectivitySummary(repo)`
  vào `infragrpc.New(...)`.
- Bảo mật: `tenant_id` luôn lấy từ `tenant.RequireTenantID(ctx)` (identity),
  request message rỗng đúng thiết kế — không có field nào trong request để
  giả mạo tenant.

**Test coverage** (`get_fleet_connectivity_summary_test.go`, 5 test, tất cả
pass): `TestGetFleetConnectivitySummary_RequiresTenantContext`,
`TestGetFleetConnectivitySummary_ReturnsOnlyCallerTenantConnections` (2
tenant, xác nhận không lẫn dữ liệu), `TestGetFleetConnectivitySummary_EmptyReturnsEmptyArrayNotNull`,
`TestGetFleetConnectivitySummary_DegradedSinceNullWhenNotDegraded`,
`TestGetFleetConnectivitySummary_RepositoryFailurePropagates`.

**Verify thật đã chạy:**
```
cd backend-go && buf generate            # sạch, chỉ infrafleet's generated files đổi
cd backend-go/services/infra-fleet-service && go build ./...   # sạch
go test ./...                                                   # tất cả pass
gofmt -l .                                                       # sạch
```

**Lưu ý trung thực:** Migration thật (0014) được test bằng cách apply/rollback
trực tiếp qua `psql` lên container `orca-go-postgres` (không qua CLI
`golang-migrate` — `schema_migrations.version` của DB này đang ở mức 6 dù
đã có 13 file migration, một drift lịch sử đã ghi chú sẵn trong
`migrations/0007_dev_server_health_status.up.sql`'s header comment; chạy
`migrate up` từ version 6 có rủi ro cao va vào schema đã áp dụng trước đó
ngoài băng ghi version). Do đó `ListConnectivitySummary`'s query (dùng cột
`degraded_since`/`grace_period_seconds` từ migration 0014) chỉ được xác
nhận đúng cú pháp/logic qua psql thủ công + unit test với fake repository,
KHÔNG có integration test tự động chạy `go test -tags=integration` (không
nằm trong scope 6 file được giao cho task này).

## Mục tiêu

RPC mới đọc `connections` join `dev_servers`, scope theo user gọi (qua
identity) — phục vụ CR-STORAGE-007's poll health tổng hợp phía frontend.

## Files cần sửa

1. `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (MODIFY — thêm message + rpc)
2. `backend-go/services/infra-fleet-service/internal/usecase/get_fleet_connectivity_summary.go` (MỚI)
3. `backend-go/services/infra-fleet-service/internal/adapter/grpc/server.go` (MODIFY — 1 handler mới)
4. `backend-go/services/infra-fleet-service/internal/adapter/postgres/connection_repository.go` (MODIFY nếu cần — thêm query join `connections`+`dev_servers` theo tenant/user)

## Nội dung proto (xem BE-SOL-STORAGE-002 §3 cho message đầy đủ)

```protobuf
message GetFleetConnectivitySummaryRequest {}
message ConnectionHealthEntry {
  string connection_id = 1;
  string dev_server_id = 2;
  string status = 3;
  google.protobuf.Timestamp last_activity_at = 4;
  google.protobuf.Timestamp degraded_since = 5;
}
message GetFleetConnectivitySummaryResponse {
  repeated ConnectionHealthEntry connections = 1;
}
rpc GetFleetConnectivitySummary(GetFleetConnectivitySummaryRequest) returns (GetFleetConnectivitySummaryResponse);
```

**Bảo mật**: `tenant_id`/user scoping đến từ gRPC metadata (identity đã
xác thực), KHÔNG qua field nào trong `GetFleetConnectivitySummaryRequest`
— request rỗng có chủ đích, đúng pattern các RPC "list của tôi" khác trong
service này.

## Test cases cần cover

- `TestGetFleetConnectivitySummary_ReturnsOnlyCallerTenantConnections` —
  2 tenant, xác nhận không lẫn dữ liệu.
- `TestGetFleetConnectivitySummary_DegradedSinceNullWhenNotDegraded`
- `TestGetFleetConnectivitySummary_EmptyReturnsEmptyArrayNotNull` — theo
  đúng convention list-channel đã có (`BE-SOL-001`'s "[]-not-null").

## Verify

```bash
cd backend-go && buf generate
cd backend-go/services/infra-fleet-service && go build ./... && go test ./...
```

## gitnexus

`impact({target: "Server", direction: "upstream"})` (infra-fleet-service's
grpc adapter) trước khi thêm handler — service này có nhiều caller
(§7 `infra-fleet-service.md`), xác nhận rủi ro trước khi đổi constructor
signature nếu cần thêm usecase mới vào đó.

## Blocking

TASK-BE-STORAGE-008 (wscompat `connectivity.getSummary`) phụ thuộc RPC này.
