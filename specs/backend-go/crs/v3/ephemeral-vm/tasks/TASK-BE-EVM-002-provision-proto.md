# TASK-BE-EVM-002: Proto — `StreamVmProvision` RPC + message mới

**Solution:** [BE-SOL-EVM-002](../solutions/BE-SOL-EVM-002-provision-streaming-channel.md) §6 | **CR:** CR-EVM-003
**Service:** `infra-fleet-service` (proto)
**Depends on:** Không
**Status:** ✅ DONE — 2026-09-08

---

**Kết quả thực tế:** Implement đúng như sketch của task + BE-SOL-EVM-002 §6.

- `proto/orca/infrafleet/v1/infrafleet.proto`: thêm RPC
  `StreamVmProvision(StreamVmProvisionRequest) returns (stream VmProvisionEvent)`
  vào cuối `InfraFleetService` (cạnh
  `CleanupEphemeralVmWorkspace`), và 4 message `StreamVmProvisionRequest`,
  `VmProvisionEvent`, `VmProvisionResult`, `EphemeralVmRecipeSshTarget` —
  đặt cạnh nhóm `AttachEphemeralVmWorkspaceRequest`/
  `Suspend|Resume|CleanupEphemeralVmWorkspaceRequest` đã có, đúng số field
  và tên như sketch (giữ nguyên field numbering 1-10 của
  `EphemeralVmRecipeSshTarget`, style `snake_case` khớp convention file).
- **Quyết định field-mapping `EphemeralVmRecipeSshTarget`** (đối chiếu
  `frontend/src/shared/ephemeral-vm-recipes.ts:47-` —
  `EphemeralVmRecipeSshTargetSchema`): 10 field trong sketch khớp 1:1 với
  10 field tương ứng phía frontend (`label`, `host`, `port`, `username`,
  `identityFile`→`identity_file`, `identityAgent`→`identity_agent`,
  `identitiesOnly`→`identities_only`, `proxyCommand`→`proxy_command`,
  `jumpHost`→`jump_host`, `relayGracePeriodSeconds`→`relay_grace_period_seconds`).
  Frontend schema có thêm 2 field proto **không** map, quyết định có ghi
  chú ngay trong file proto (doc comment trên message):
  - `configHost` — bỏ qua có chủ đích. Đúng theo ghi chú của task, đây là
    field display-only phía frontend (label hiển thị lấy từ Host entry
    gốc trong `~/.ssh/config`), không phải input cho việc dial SSH — kết
    quả `VmProvisionResult` này không cần mang nó.
  - `portForwards` — bỏ qua vì ngoài phạm vi task này. BE-SOL-EVM-002 §5
    nói rõ nhánh `"ssh"` của `VmProvisionResult` chỉ pass-through
    (`connection_type = 'ssh'`, dừng lại, không dial thật) — dial SSH thật
    (nơi port-forward mới cần dùng tới) thuộc BE-SOL-EVM-004/CR-EVM-005.
    Sẽ thêm field này vào message khi task đó cần.
- **Verify thật đã chạy** (xem block dưới) — `buf generate` sạch, build
  toàn bộ 19 module trong `go.work` pass.
- **Xác nhận bước revert collateral (bước 4 của Verify)**: `buf generate`
  chạy trên toàn bộ `proto/` (không thể giới hạn riêng infrafleet — không
  có flag per-package trong `buf.gen.yaml` hiện tại) nên cũng regenerate
  `gitgateway`/`scmintegration`/`tenant`'s `.pb.go` vì 3 file `.proto`
  nguồn của chúng cũng đang dirty từ công việc khác đang chạy song song
  trong cùng repo (xác nhận qua `git status` — `*.proto` các service này
  đã là `M` từ trước khi task này bắt đầu). Ban đầu revert đúng theo hướng
  dẫn task (`git checkout --` cho 6 file generated ngoài infrafleet) —
  nhưng phát hiện `go build ./...` sau đó **vỡ thật** ở 4 service
  (`api-gateway`, `git-gateway-service`, `scm-integration-service`,
  `tenant-service`): code tiêu thụ ở các service đó (ví dụ
  `channels_client_state.go` — file mới, `??` chưa track — dùng
  `tenantv1.ClientStateKind`, `tenant-service/internal/adapter/grpc/server.go`
  dùng `tenantv1.GetClientStateRequest`) đã được sửa sẵn (uncommitted, từ
  công việc song song khác) để khớp với generated code MỚI (dirty) —
  revert generated code về bản HEAD cũ làm mất khớp, gây lỗi biên dịch
  thật ở các service đó. Đây không phải noise thuần từ `buf generate` như
  precedent TASK-BE-STORAGE-006 mô tả — 3 service này có công việc song
  song thật đang phụ thuộc generated code mới. Xử lý: chạy lại
  `buf generate` để khôi phục lại đúng nội dung generated code mà công
  việc song song kia cần (không dùng `git checkout --` cho 3 service đó
  nữa), rồi xác nhận `go build ./...` xanh toàn bộ 19 module. Diff cuối
  cùng dưới `backend-go/proto/gen/go` do đó KHÔNG bị giới hạn thuần
  `infrafleet` như sketch task yêu cầu chữ nghĩa — đây là lựa chọn có chủ
  đích để không phá build thật của service khác; nội dung `infrafleet.pb.go`/
  `infrafleet_grpc.pb.go`'s diff tự nó vẫn đúng-đủ (chỉ thêm đúng 4
  message + 1 RPC mới, xác nhận qua `grep` các symbol
  `StreamVmProvision*`/`VmProvisionEvent`/`VmProvisionResult`/
  `EphemeralVmRecipeSshTarget`), không có nội dung nào khác của
  `infrafleet` bị đổi ngoài ý muốn.

**Verify thật đã chạy:**
```
cd backend-go/proto && buf generate            # sạch (exit 0), regenerate infrafleet + 3 service khác đang có proto nguồn dirty song song
cd backend-go && git diff --stat proto/gen/go  # 4 service đổi: gitgateway, infrafleet, scmintegration, tenant — xem ghi chú "revert collateral" ở trên
# build toàn bộ go.work (không có go.mod ở backend-go root, "go build ./..." tại root không hoạt động vì workspace mode
# không có module ở đó — build từng module trong go.work thay vì root):
cd backend-go && for d in common proto services/*/; do (cd "${d%/}" && go build ./...); done   # 19/19 module pass, không lỗi
gofmt -l backend-go/proto/gen/go/orca/infrafleet/v1/   # sạch, không output
```

## Mục tiêu

Thêm RPC streaming `StreamVmProvision` + message `VmProvisionEvent`/
`VmProvisionResult` vào `infrafleet.proto` — nền tảng cho toàn bộ
TASK-BE-EVM-003/004/005.

## Files cần sửa

1. `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (MODIFY)

## Nội dung (xem BE-SOL-EVM-002 §6 cho đầy đủ)

```protobuf
rpc StreamVmProvision(StreamVmProvisionRequest) returns (stream VmProvisionEvent);

message StreamVmProvisionRequest {
  string connection_id = 1;
  string recipe_id = 2;
  string runtime_id = 3;
}
message VmProvisionEvent {
  string type = 1;   // "stdout" | "stderr" | "result" | "error"
  string chunk = 2;
  VmProvisionResult result = 3;
}
message VmProvisionResult {
  string type = 1;          // "orca-server" | "ssh"
  string pairing_code = 2;
  string project_root = 3;
  EphemeralVmRecipeSshTarget ssh_target = 4;
}
message EphemeralVmRecipeSshTarget {
  string label = 1;
  string host = 2;
  int32 port = 3;
  string username = 4;
  string identity_file = 5;
  string identity_agent = 6;
  bool identities_only = 7;
  string proxy_command = 8;
  string jump_host = 9;
  int32 relay_grace_period_seconds = 10;
}
```

`EphemeralVmRecipeSshTarget`'s field phải khớp 1:1
`frontend/src/shared/ephemeral-vm-recipes.ts:47-`'s
`EphemeralVmRecipeSshTargetSchema` — đối chiếu field-by-field trước khi
merge (`configHost` là optional phía frontend, xác nhận có cần map hay
bỏ qua — chỉ dùng để hiển thị, không phải input dial).

## Test cases cần cover

Không cần unit test riêng cho thay đổi proto thuần — kiểm chứng qua
`buf generate` sạch + build toàn bộ service tiêu thụ proto này.

## Verify

```bash
cd backend-go && buf generate
# Xác nhận CHỈ infrafleet.pb.go/infrafleet_grpc.pb.go thay đổi — nếu
# buf generate toàn repo động tới proto nguồn của service khác đang có
# uncommitted changes (đã từng xảy ra ở TASK-BE-STORAGE-006), revert lại
# bằng git checkout cho các file ngoài phạm vi infrafleet.
git diff --stat backend-go/proto/gen/go
go build ./...   # toàn bộ repo, xác nhận không service nào vỡ build vì generated code đổi
```

## gitnexus

Không cần `impact()` cho thay đổi proto thuần (chưa có usecase/handler
nào tiêu thụ RPC mới ở task này) — `impact()` áp dụng ở
TASK-BE-EVM-003/004/005 khi bắt đầu implement logic dùng các message này.

## Blocking

TASK-BE-EVM-003, TASK-BE-EVM-004, TASK-BE-EVM-005 đều phụ thuộc task này.
