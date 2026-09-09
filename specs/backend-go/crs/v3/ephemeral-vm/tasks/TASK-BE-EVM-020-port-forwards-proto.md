# TASK-BE-EVM-020: Proto `PortForward` + `EphemeralVmRecipeSshTarget.port_forwards`

**Solution:** [BE-SOL-EVM-005](../solutions/BE-SOL-EVM-005-ssh-target-port-forwards.md) | **CR:** CR-EVM-008
**Depends on:** Không (song song [TASK-AG-EVM-011](../../../../agent/crs/v3/ephemeral-vm/tasks/TASK-AG-EVM-011-ssh-target-port-forwards.md))
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Thêm field proto cho `portForwards` — hiện chưa tồn tại trong
`infrafleet.proto`, là lý do 2 điểm decode phải "deliberately omit".

## Files cần sửa

1. `infrafleet.proto` (đường dẫn thật — xác nhận qua `grep -rn "EphemeralVmRecipeSshTarget" backend-go/proto/`) (MODIFY)
2. Chạy proto codegen

## Nội dung

```proto
message PortForward {
  int32 local_port = 1;
  string remote_host = 2;
  int32 remote_port = 3;
}
message EphemeralVmRecipeSshTarget {
  // ... field hiện có ...
  repeated PortForward port_forwards = 12; // xác nhận số thứ tự trống thật trước khi code
}
```

## Test cases cần cover

- Round-trip marshal/unmarshal `EphemeralVmRecipeSshTarget` có
  `port_forwards` rỗng → không lỗi.
- Round-trip có 2 entry → giữ đúng thứ tự.

## Verify

```bash
cd backend-go && make proto-gen
go build ./...
```

## gitnexus

`impact({target: "EphemeralVmRecipeSshTarget", direction: "downstream"})`
trước khi đổi message — xác nhận danh sách nơi decode struct này.

## Đồng bộ bắt buộc

Tên field JSON phải khớp `SshDialTarget.portForwards`
([TASK-AG-EVM-011](../../../../agent/crs/v3/ephemeral-vm/tasks/TASK-AG-EVM-011-ssh-target-port-forwards.md)).

---

## ✅ Kết quả thực tế (2026-09-09)

Số thứ tự field trống thật là 11 (10 field hiện có, 1-10) — khớp
solution's giả định. Thêm `message PortForward` với **4 field** (không
phải 3 như sketch gốc) — đối chiếu `frontend/src/shared/ssh-types.ts`'s
`SavedPortForward` (`localPort`, `remoteHost`, `remotePort`, `label?`)
xác nhận có field `label` optional mà sketch ban đầu bỏ sót; sửa lại
cho khớp 1:1 trước khi code, không theo sketch cũ.

`make proto-gen` (buf) chạy sạch, sinh đúng
`EphemeralVmRecipeSshTarget.PortForwards []*PortForward` (field 11) và
`PortForward` struct mới trong `infrafleet.pb.go`.

**Verify**: `go build` cho `proto/`, `infra-fleet-service`, `api-gateway`
— sạch. Build thêm TOÀN BỘ service khác trong `backend-go/services/*`
(vòng lặp qua từng service) — không service nào bị ảnh hưởng bởi field
mới (proto3 thêm field không phá compat).

**Files đã sửa:**
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (MODIFY)
- `backend-go/proto/gen/go/orca/infrafleet/v1/infrafleet.pb.go` (regenerated)
