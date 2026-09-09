# TASK-AG-EVM-011: `portForwards` cho `ssh-outbound-client.ts` (Hướng A)

**Solution:** [SOL-AG-EVM-004](../solutions/SOL-AG-EVM-004-ssh-target-port-forwards.md) | **CR:** CR-EVM-008
**Depends on:** Không (song song [TASK-BE-EVM-020](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-020-port-forwards-proto.md))
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Thêm field `portForwards` vào `SshDialTarget`, setup local listener
forward qua `Client.forwardOut()` (đã dùng thật trong file này cho
double-hop, dòng 160) sau khi kết nối SSH thành công.

## Files cần sửa

1. `agent/src/relay/ssh-outbound-client.ts` (MODIFY)
2. `agent/src/relay/ssh-outbound-client.test.ts` (MODIFY — thêm test)

## Nội dung (xem SOL-AG-EVM-004 §2)

```ts
export type SshDialTarget = {
  // ... field hiện có ...
  portForwards?: Array<{ localPort: number; remoteHost: string; remotePort: number }>
}

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

Gọi `setupPortForwards` sau `client.on('ready', ...)`, lưu `net.Server[]`
để cleanup khi `client.on('close', ...)` — mỗi `server.close()`.

## Test cases cần cover

- Connect thành công + `portForwards` có 2 entry → 2 `net.Server` được tạo, listen đúng port.
- Kết nối SSH đóng → mọi `net.Server` được đóng (không port leak).
- `portForwards` rỗng/undefined → không tạo server nào, hành vi không đổi so với trước.
- Port cục bộ đã bị chiếm → lỗi propagate rõ ràng, không silent fail.

## Verify

```bash
cd agent && npx vitest run src/relay/ssh-outbound-client.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "dialOutboundSshTarget", direction: "downstream"})`
trước khi sửa — xác nhận mọi caller (backend-go's `vm.sshDial` RPC) vẫn
hoạt động đúng với field mới optional.

## Đồng bộ bắt buộc

Merge cùng lúc [TASK-BE-EVM-020](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-020-port-forwards-proto.md)
— tên field JSON phải khớp 1:1.

---

## ✅ Kết quả thực tế (2026-09-09)

**Lệch so với sketch — 2 điểm**:
1. **Fail loudly, không silent**: sketch gốc không xử lý lỗi
   `server.listen()`. Vì `net.Server.listen()` không throw đồng bộ cho
   lỗi như `EADDRINUSE` (khác Go's `net.Listen` trả error ngay), phải
   bọc mỗi `listen()` trong 1 Promise chờ `'listening'`/`'error'`, để 1
   port bị chiếm làm FAIL TOÀN BỘ `dialOutboundSshTarget` — nhất quán
   với Hướng B (backend-go) vừa implement (TASK-BE-EVM-022).
2. **Cleanup khi dial thất bại giữa chừng**: nếu forward thứ 2 lỗi sau
   khi forward thứ 1 đã listen thành công, forward thứ 1 phải được đóng
   lại trước khi throw — thêm nhánh cleanup riêng trong
   `setupPortForwards`, ngoài nhánh cleanup ở catch chính của
   `dialOutboundSshTarget`.

**Phát hiện phụ quan trọng (ngoài phạm vi file `ssh-outbound-client.ts`)**:
`backend-go`'s `DialHiddenSshTarget` (`devserveragent/methods.go`) — RPC
gửi `vm.sshDial` params cho agent — **hoàn toàn không có field
`portForwards`** trong params map, dù `domain.EphemeralVmSshTarget.PortForwards`
đã có dữ liệu từ TASK-BE-EVM-021. Đây là gap thứ 4 không nằm trong danh
sách gốc — nếu không sửa, `SshDialTarget.portForwards` ở agent luôn nhận
`undefined` dù backend-go đã biết đúng giá trị. Đã sửa cùng lúc
(`toWirePortForwards` helper, thêm `"portForwards": ...` vào params map).

**Test mới** (`ssh-outbound-client.test.ts`, 4 test, describe block
`portForwards`):
- Mở local listener + gọi đúng `forwardOut` khi có connection thật tới.
- Data pipe 2 chiều qua channel thật (dùng `PassThrough` làm fake channel
  echo, không dùng default `{fake:'channel'}` vì không phải stream thật).
- `close()` đóng listener — connect sau đó thất bại.
- Port cục bộ đã bị chiếm → cả `dialOutboundSshTarget` reject, client
  ssh2 bị `end()`.

Phát hiện phụ khi viết test: default `nextForwardOutChannel = {fake:
'channel'}` trong mock không phải stream thật — dùng trực tiếp với
`.pipe()` gây `Unhandled Exception` (test vẫn "pass" vì lỗi xảy ra sau
assertion, nhưng gây ô nhiễm test run) — phải set
`nextForwardOutChannel = new PassThrough()` trước khi kết nối thật ở
mọi test cần data thật đi qua channel.

**Verify**: `npx tsc --noEmit` — 0 lỗi. `npx vitest run
src/relay/ssh-outbound-client.test.ts` — 22/22 pass (18 cũ + 4 mới), 0
unhandled error.

**Files đã sửa:**
- `agent/src/relay/ssh-outbound-client.ts` (MODIFY)
- `agent/src/relay/ssh-outbound-client.test.ts` (MODIFY — thêm describe block `portForwards`, 4 test)
- `backend-go/services/infra-fleet-service/internal/adapter/devserveragent/methods.go` (MODIFY — `DialHiddenSshTarget` thiếu `portForwards`, phát hiện phụ)
