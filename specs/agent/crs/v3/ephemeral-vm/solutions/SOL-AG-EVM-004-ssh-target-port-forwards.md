# SOL-AG-EVM-004: `portForwards` cho SSH outbound client (Hướng A)

> **🔲 Designed — chưa implement.** Tái dùng `Client.forwardOut()` đã
> dùng thật trong cùng file cho double-hop — không thêm dependency mới.

**CR:** [CR-EVM-008](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-008-ssh-target-port-forwards.md)
**backend-go counterpart:** [BE-SOL-EVM-005](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-005-ssh-target-port-forwards.md)
**TDD tham chiếu:** [TDD-AG-07](../../../../tdd/v5/07-jsonrpc-dispatch.md) §1

---

## 1. Trạng thái hiện tại

`ssh-outbound-client.ts:160` đã dùng `jumpClient.forwardOut('127.0.0.1',
0, target.host, target.port, callback)` cho double-hop qua jump host —
xác nhận `ssh2`'s `forwardOut` (mở `direct-tcpip` channel qua kết nối
SSH đã có) là primitive khả dụng, đã chạy thật trong file này. Chưa có
field `portForwards` nào trong `SshDialTarget` (dòng 33-42), và không có
code nào set up local listener để forward.

## 2. Giải pháp

### Thêm `portForwards` vào `SshDialTarget` (khớp proto mới ở BE-SOL-EVM-005)

```ts
export type SshDialTarget = {
  // ... field hiện có ...
  portForwards?: Array<{ localPort: number; remoteHost: string; remotePort: number }>
}
```

### Setup forward sau khi connect thành công

```ts
// Sau khi ssh2 Client 'ready' event, trước khi trả kết nối cho caller:
function setupPortForwards(client: Ssh2Client, forwards: SshDialTarget['portForwards']): net.Server[] {
  return (forwards ?? []).map(({ localPort, remoteHost, remotePort }) => {
    const server = net.createServer((localSocket) => {
      client.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, channel) => {
        if (err) { localSocket.destroy(err); return }
        localSocket.pipe(channel).pipe(localSocket)
      })
    })
    server.listen(localPort, '127.0.0.1')
    return server
  })
}
```

Đúng pattern `dialViaJumpHost`'s callback shape đã dùng ở dòng 160 —
không viết TCP proxy tay từ đầu, chỉ mở rộng cách dùng `forwardOut` đã
có sang 1 local listener thay vì 1 channel đơn lẻ cho double-hop.

### Cleanup

`server.close()` cho mọi forward khi kết nối SSH đóng (`client.on('close', ...)`)
— tránh port bị giữ sau khi VM bị destroy/suspend.

## 3. Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Đồng bộ với BE-SOL-EVM-005 | Cao | Field `portForwards` trong `SshDialTarget` phải khớp tên/kiểu với proto mới — merge cùng lúc |
| Port cục bộ đã bị chiếm (conflict) | Trung bình | `server.listen()` lỗi cần propagate rõ ràng, không silent fail |
| Không áp dụng cho Hướng B (`ephemeralsshconn`) | Thấp, có chủ đích | Solution này chỉ Hướng A — xem BE-SOL-EVM-005 cho Hướng B, `EPHEMERAL_VM_SSH_MODE` quyết định hướng nào chạy |

## Không thuộc phạm vi solution này

- Hướng B (`backendrelaysshprovisioner`/`ephemeralsshconn`) — xem
  [BE-SOL-EVM-005](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-005-ssh-target-port-forwards.md).
- UI hiển thị port đã forward — ngoài phạm vi CR-EVM-008 (Tầng chỉ
  `agent`+`backend-go`).

## Liên quan

- `agent/src/relay/ssh-outbound-client.ts:33-42,160` (`SshDialTarget`, `forwardOut` tiền lệ)
- [BE-SOL-EVM-005](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-005-ssh-target-port-forwards.md)
