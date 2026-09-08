# frontend Tasks — Ephemeral VM

**Solutions:** [../solutions/](../solutions/README.md)

| Task | Solution | Depends on | Status |
|---|---|---|---|
| [FE-TASK-EVM-001](./FE-TASK-EVM-001-remove-stale-suppressor-and-routing-audit.md) — gỡ suppressor + audit routing | FE-SOL-EVM-001 | Không | ✅ DONE |
| [FE-TASK-EVM-002](./FE-TASK-EVM-002-subscribe-runtime-stream-channel-client.md) — `subscribeRuntimeStreamChannel` | FE-SOL-EVM-002 | [TASK-BE-EVM-005](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-005-wscompat-provision-channel.md) (DONE) | ✅ DONE |
| [FE-TASK-EVM-003](./FE-TASK-EVM-003-runtime-ephemeral-vm-client-provision-wiring.md) — route `provision`/`cancelProvision` | FE-SOL-EVM-002 | 002 (DONE), [TASK-BE-EVM-005](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-005-wscompat-provision-channel.md) (DONE) | ✅ DONE |

## Thứ tự thực thi

```
FE-TASK-EVM-001 → độc lập hoàn toàn, làm sớm
FE-TASK-EVM-002 → phụ thuộc backend-go's TASK-BE-EVM-005 (đã ship — DONE)
FE-TASK-EVM-003 → phụ thuộc 002
```

Cả 3 task frontend của nhóm CR ephemeral-vm này đều ✅ DONE. Integration
test cuối cùng cho `ephemeralVm.provision` (FE-TASK-EVM-002/003) chạy
against wire shape THẬT xác nhận qua `channels_ephemeral_vm.go`/
`channels_ephemeral_vm_test.go`/`push_bridge.go`, không phải mock giả định
— nhưng KHÔNG phải 1 test cross-process thật (`frontend/` package không có
tiền lệ/hạ tầng cho việc đó; xem "Kết quả thực tế" của FE-TASK-EVM-002 cho
audit đầy đủ).

## Nguyên tắc chung cho AI thực thi các task này

- **Luôn chạy `impact()`/`codegraph explore` trước khi sửa symbol.**
- **Không đổi hành vi desktop (`window.api.ephemeralVm.*`)** — cả 3 task
  chỉ thêm/sửa nhánh web/paired (`target.kind === 'environment'`), giữ
  nguyên desktop-local path.
- **Audit trước khi viết, không giả định đã có sẵn** — đặc biệt
  FE-TASK-EVM-002's "có hook push-by-channel chưa" và FE-TASK-EVM-001's
  "field response có khớp không" — cả 2 đều yêu cầu đọc source thật
  trước khi code, không suy đoán từ TDD.
- **Test trước, không giả định pass.**
