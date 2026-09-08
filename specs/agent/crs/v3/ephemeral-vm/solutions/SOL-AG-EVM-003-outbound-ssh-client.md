# SOL-AG-EVM-003: Agent trở thành outbound SSH client (`ssh`-type ephemeral VM)

> **🔲 Designed — sketch, chưa committed.** Subsystem lớn nhất trong cả
> nhóm CR ephemeral-vm. Không có tiền lệ code thật để mirror trực tiếp
> (khác 001/002) — solution này phác thảo hướng đi, cần 1 vòng thiết kế
> riêng trước khi implement.
>
> **Cập nhật 2026-09-08**: Đây là **Hướng A** trong 2 hướng song song đã
> chốt ở [CR-EVM-005 §"Quyết định"](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-005-ssh-connection-type-outbound-client.md#quyết-định-2026-09-08-2-hướng-song-song-chọn-qua-config-backend-go) —
> chỉ chạy khi backend-go's `EPHEMERAL_VM_SSH_MODE=agent-outbound`. Hướng B
> (`backend-relay-deploy`, [BE-SOL-EVM-004 §5](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md#5-hướng-b-mới-2026-09-08--tái-dùng-sshconnsshrelay-config-selected))
> KHÔNG cần bất kỳ thay đổi nào ở `agent/` — nếu config chọn Hướng B,
> solution này không được thực thi.

**CR:** [CR-EVM-005](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-005-ssh-connection-type-outbound-client.md)
**backend-go counterpart:** [BE-SOL-EVM-004](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md)
**TDD tham chiếu:** [TDD-AG-03](../../../../tdd/v5/03-connection-modes.md) §1-2 (2 chế độ WebSocket hiện có, để đối chiếu — không mô tả outbound SSH)

---

## 1. Xác nhận lại: không có gì để tái dùng trực tiếp

Khác với SOL-AG-EVM-001/002 (đều tái dùng module có sẵn), audit
2026-09-08 xác nhận:

```bash
grep -rn "from 'ssh2'" agent/src --include=*.ts | grep -v test
# → không có kết quả
```

`agent/package.json` có `ssh2`/`@types/ssh2` trong dependencies nhưng
chưa dùng cho outbound. Toàn bộ `ssh-*.ts` hiện có trong `agent/src`
implement chiều **inbound** (agent bị Orca reach tới qua 1 kênh exec SSH
Orca đã mở) — không có logic dial-out nào để mirror.

`TDD-AG-03` §1-2 mô tả 2 chế độ agent↔Orca hiện có
(`agent-connection-direct.ts`/`agent-connection-relay.ts`) — cả 2 đều là
WebSocket giữa agent và chính Orca, không phải SSH tới bên thứ 3. Không
chế độ nào trong đây mô tả được outbound SSH client — xác nhận đúng kết
luận BACKLOG-001: đây là **năng lực hoàn toàn mới**, không phải mở rộng
1 trong 2 chế độ đã có.

## 2. Kiến trúc đề xuất (sketch)

### 2a. Module mới: `agent/src/relay/ssh-outbound-client.ts`

```ts
import { Client as Ssh2Client } from 'ssh2'
import type { EphemeralVmRecipeSshTarget } from '../shared/ephemeral-vm-recipes'  // type dùng chung, không đổi

export async function dialOutboundSshTarget(
  target: EphemeralVmRecipeSshTarget
): Promise<OutboundSshSession> {
  // target: host/port/username/identityFile/identityAgent/identitiesOnly/
  // proxyCommand/jumpHost/relayGracePeriodSeconds — schema đã có sẵn,
  // KHÔNG đổi (frontend/src/shared/ephemeral-vm-recipes.ts:47-)
  const client = new Ssh2Client()
  // ... connect logic, xử lý jumpHost/proxyCommand nếu có ...
}
```

`identityFile` không được đọc trực tiếp từ đĩa của recipe author —
`backend-go` (BE-SOL-EVM-004 mục 2) đưa material qua Vault SSH secrets
engine, agent nhận credential đã resolve qua kênh an toàn (cơ chế cụ thể
— tham số RPC hay 1 lần fetch riêng — là quyết định thiết kế cần chốt
trước khi implement, không sketch ở đây).

### 2b. Hidden-target registry (agent-local, khớp với BE-SOL-EVM-004's bảng)

Agent giữ 1 map `runtimeId → OutboundSshSession` trong bộ nhớ (tương tự
`provisionAbortRegistry` ở SOL-AG-EVM-002) — không lưu ra đĩa, sống theo
vòng đời process agent. Khi agent restart, mọi outbound SSH session mất
— `backend-go` cần phát hiện qua lỗi relay và (tuỳ CR-EVM-005 mục 4's
quyết định kiến trúc) re-dial hoặc báo lỗi rõ ràng cho user.

### 2c. fs/git provider dispatch — mirror kiến trúc, không mirror code

`ssh-filesystem-stream-reader.ts`/`ssh-git-response-stream-reader.ts`
hiện có đọc dữ liệu từ 1 kênh SSH **Orca đã mở vào agent** (inbound). Cho
hidden target, hướng dữ liệu ngược lại: agent tự đọc fs/git **qua session
SSH nó vừa dial ra** (`OutboundSshSession` ở mục 2a), rồi relay kết quả
đó ngược về Orca qua **kênh agent↔Orca hiện có** (WebSocket, không phải
SSH) — tức 2 module mới `ssh-outbound-filesystem-provider.ts`/
`ssh-outbound-git-provider.ts`, dùng `ssh2`'s SFTP/exec API trực tiếp
trên `OutboundSshSession`, không tái dùng code đọc-frame-SSH-inbound
hiện có (khác chiều dữ liệu hoàn toàn, chỉ giống ở "cuối cùng cũng đọc
fs/git qua SSH").

## 3. Xử lý kết quả `provision` — điểm nối với SOL-AG-EVM-002

Khi `handleVmProvision` ([SOL-AG-EVM-002](./SOL-AG-EVM-002-vm-provision-streaming-handler.md))
parse `EphemeralVmRecipeResultSchema` và nhận `{type: 'ssh', target,
projectRoot}`, nó **không** tự dial — chỉ đưa `target` nguyên vẹn vào
`stream.end`'s `provisionResult`. Việc dial thật (mục 2a) là 1 bước
**riêng biệt, sau đó**, khởi động bởi backend-go's `AttachWorkspace` (khi
user thật sự attach workspace vào runtime `ssh`-type này) — không dial
ngay khi provision xong, tránh giữ 1 kết nối SSH mở cho VM có thể không
bao giờ được dùng.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Không có tiền lệ code để mirror | Cao | Đây là lý do CR-EVM-005 xếp P3 — cần 1 vòng thiết kế riêng (kiến trúc + bảo mật) trước khi biến sketch này thành spec implement được |
| `identityFile`/`identityAgent` credential material qua kênh nào | Cao, chưa quyết | Mục 2a's placeholder — quyết định này ảnh hưởng cả agent lẫn backend-go (BE-SOL-EVM-004), cần chốt trước |
| Agent restart làm mất mọi outbound SSH session đang mở | Trung bình | Không có cơ chế phục hồi tự động trong sketch này — cần quyết định UX (báo lỗi rõ, hay tự re-dial) trước khi implement |
| jumpHost/proxyCommand support của `ssh2` | Trung bình | Cần xác nhận thư viện `ssh2` hỗ trợ đủ các field `EphemeralVmRecipeSshTargetSchema` đã khai báo (`jumpHost`, `proxyCommand`) — có thể cần code thêm ngoài API `ssh2` cung cấp sẵn |

## Không thuộc phạm vi solution này

- Nhánh `orca-server` — xem
  [SOL-AG-EVM-001](./SOL-AG-EVM-001-vm-exec-handler.md)/
  [SOL-AG-EVM-002](./SOL-AG-EVM-002-vm-provision-streaming-handler.md).
- Bảng hidden-target/Vault ACL ở backend-go — xem
  [BE-SOL-EVM-004](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md).
- Quyết định kiến trúc fs/git surface qua `git-gateway-service` (CR-EVM-005
  mục 4) — không giải quyết ở đây, chỉ nêu hướng agent-side.

## Quyết định đã chốt (TASK-AG-EVM-004)

Kết quả 1 vòng đọc source thật (`agent/package.json`, `agent/node_modules/@types/ssh2@1.17.0/index.d.ts`,
`ssh-filesystem-stream-reader.ts`/`ssh-git-response-stream-reader.ts`,
`frontend/src/shared/ephemeral-vm-recipes.ts:47-`,
`ssh-target-save-payload.test.ts` cho semantics thật của `jumpHost`/`proxyCommand`) —
2026-09-08.

> **✅ Đối chiếu xác nhận khớp (2026-09-08)** — TASK-BE-EVM-009 (backend-go,
> [BE-SOL-EVM-004 §"Quyết định đã chốt"](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md#quyết-định-đã-chốt-task-be-evm-009))
> hoàn thành độc lập, chốt đúng cùng cơ chế cho quyết định 1: RPC param,
> `infra-fleet-service` resolve Vault trước, agent không tự gọi Vault, gắn
> với `AttachWorkspace`. Không mâu thuẫn.

### 1. Kênh nhận credential material (`identityFile`/`identityAgent`)

**Chốt: RPC parameter, KHÔNG phải agent tự fetch Vault.** `backend-go`
(`infra-fleet-service`, qua Vault SSH secrets engine — xem
BE-SOL-EVM-004 §2) resolve `identityFile` (private key content, không
phải path) trước, rồi gửi material đó **theo giá trị**, làm tham số của
chính RPC kích hoạt dial (RPC gắn với `AttachWorkspace`, xem mục 4) — mô
hình giống hệt cách `vm.exec`-style call truyền tham số ngày nay, qua
kênh agent↔Orca hiện có (đã mã hoá + xác thực, không phải kênh mới).

Lý do loại phương án "agent tự fetch riêng qua Vault": agent chạy trên
máy user (native/WSS/SSH-relay), không có (và không nên có) Vault
token — cấp Vault token cho agent phá vỡ đúng nguyên tắc mặc định "no
other service talks to Vault directly" (`06-secrets-vault-architecture.md`)
mà TASK-BE-EVM-009's quyết định 2 đang review riêng cho
`infra-fleet-service`. Agent chỉ nên là bên **nhận** material đã resolve,
không phải bên tự đi lấy.

Ràng buộc kèm theo (khớp SOL §2b): agent **không bao giờ ghi
`identityFile` material ra đĩa** — chỉ giữ trong bộ nhớ tiến trình, sống
theo vòng đời `OutboundSshSession`, drop khi session đóng. `identityAgent`
(đường dẫn UNIX socket ssh-agent) không mang secret qua RPC — chỉ là 1
string tham chiếu tới ssh-agent **cục bộ trên host agent đang chạy**;
agent dùng trực tiếp `agent` field của `ssh2`'s `ConnectConfig`, không
cần backend-go resolve gì thêm cho field này.

> ⚠️ **Cần đối chiếu:** [TASK-BE-EVM-009](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-009-ssh-design-decisions.md)
> (agent đối xứng, backend-go) còn ở trạng thái 🔲 TODO tại thời điểm viết
> quyết định này. Quyết định 1 ở đây là **đề xuất phía agent** cho hướng
> "RPC parameter" (1 trong 2 lựa chọn TASK-BE-EVM-009 liệt kê) — cần
> backend-go's task xác nhận khớp trước khi bất kỳ task code nào
> (TASK-AG-EVM-005+ hoặc TASK-BE-EVM-010+) dùng quyết định này làm nền.

### 2. `ssh2` hỗ trợ `jumpHost`/`proxyCommand` — KHÔNG có sẵn, cần code thêm

Đọc trực tiếp `@types/ssh2@1.15.5`'s `index.d.ts` (khớp `ssh2@1.17.0`
runtime cài trong `agent/node_modules`, xác nhận version thật qua
`agent/package.json`): `ConnectConfig` **không có field `jumpHost` hay
`proxyCommand`** — 2 field này là construct riêng của
`EphemeralVmRecipeSshTargetSchema`/OpenSSH `ssh_config` (`ProxyJump`/
`ProxyCommand`), không map thẳng 1-1 vào API `ssh2`.

`ssh2` cung cấp đúng 2 primitive cần để tự lắp cả hai, không hơn:

- `ConnectConfig.sock?: Readable` — "A ReadableStream to use for
  communicating with the server instead of creating and using a new TCP
  connection (useful for connection hopping)" (`index.d.ts:752`, verbatim
  từ doc comment thật).
- `Client.prototype.forwardOut(srcIP, srcPort, dstIP, dstPort, callback)`
  (`index.d.ts:650`) — mở 1 kênh `direct-tcpip` qua 1 connection `ssh2`
  đã có, trả về 1 `Duplex` stream dùng làm `sock`.

Từ đó, code thêm cần viết (task code sau, không phải task này):

- **`jumpHost`** (test fixture xác nhận format là hostname trần, ví dụ
  `'bastion.example.com'`, không phải `user@host:port` đầy đủ — cần xác
  nhận lại parse rule khi viết task code): dial 1 `Ssh2Client` phụ tới
  jump host trước → gọi `forwardOut()` trên client đó để mở tunnel tới
  `host:port` thật → truyền `Duplex` kết quả vào `sock` của
  `Client.connect()` cho target thật. Đây là "double hop" idiom chuẩn của
  `ssh2`, không phải hack.
- **`proxyCommand`** (test fixture xác nhận là 1 dòng lệnh shell thật,
  ví dụ `'cloudflared access ssh --hostname %h'`, kiểu OpenSSH
  `ProxyCommand` với token `%h`/`%p`): `ssh2` không tự spawn lệnh này —
  cần spawn qua `child_process`, bọc `stdin`/`stdout` của process con
  thành 1 `Duplex` thủ công (không có sẵn trong `ssh2`), rồi cũng truyền
  vào `sock`. Cross-platform: spawn qua shell mặc định của host (khác
  nhau Windows/macOS/Linux — theo AGENTS.md's Cross-Platform Support,
  không hardcode `/bin/sh`).

**Kết luận:** không có support "miễn phí" — cả 2 field cần 1 lớp code
adapter mỏng trong `ssh-outbound-client.ts`, dùng đúng 2 primitive
`sock`/`forwardOut` `ssh2` đã cung cấp. Rủi ro triển khai ở mức
**Trung bình** (không phải Cao) vì primitive cần thiết đã có sẵn, không
cần vá `ssh2` hay tự implement transport layer.

### 3. Hidden-target registry — KHÔNG persist qua restart; xác nhận UX

**Chốt: giữ nguyên mặc định SOL §2b — in-memory only, không ghi đĩa.**
Agent restart làm mất mọi `OutboundSshSession` đang mở, không có gì để
khôi phục từ agent phía này (đúng tinh thần `provisionAbortRegistry`'s
tiền lệ ở SOL-AG-EVM-002).

UX xác nhận: **tự động thử dial lại 1 lần (transparent retry), không báo
lỗi ngay.** Cơ sở: quyết định 1 (credential material truyền theo giá trị
trong RPC, không phải agent tự cache/fetch) làm cho **dial luôn là 1
thao tác "cold" idempotent** — agent không giữ state nào sống sót qua
restart mà 1 lần dial lại cần tới, nên backend-go **có thể** phát lại y
nguyên RPC dial ban đầu (Vault SSH secrets engine cấp cert/key ngắn hạn
mới nếu cái cũ hết hạn) mà không cần hỏi lại user. Điều này khớp pattern
reconnect đã có ở `agent-connection-relay.ts` (agent↔Orca WS
reconnect) — mirror kiến trúc, không phải cơ chế mới.

Trách nhiệm chia rõ: **agent** chỉ cần đảm bảo `dialOutboundSshTarget`
an toàn khi gọi lại nhiều lần (không có side effect ngầm giả định
"resume" từ session cũ) — không cần tự nhớ gì để "khôi phục". **backend-go**
(`BE-SOL-EVM-004`'s error handling, quyết định thuộc TASK-BE-EVM-009)
chịu trách nhiệm: phát hiện session mất qua lỗi relay hiện có, tự phát
lại RPC dial 1 lần, và chỉ báo lỗi rõ cho user nếu lần retry đó cũng
fail (ví dụ agent thật sự down, không chỉ vừa restart).

> ⚠️ **Cần đối chiếu:** phần "backend-go tự động retry" ở trên là đề xuất
> từ phía agent — TASK-BE-EVM-009 (còn TODO) là nơi chốt chính thức cơ
> chế retry/backoff cụ thể phía `BE-SOL-EVM-004`.

### 4. Thời điểm dial thật — xác nhận: `AttachWorkspace`, đây là quyết định cuối

**Chốt: đúng như SOL §3 đã sketch — dial khi `AttachWorkspace`, không
phải ngay sau `provision`.** Không tìm thấy lý do kiến trúc nào để đảo
lại trong lượt đọc source này; xác nhận đây là quyết định cuối, không
phải 1 trong nhiều lựa chọn còn mở.

Hệ quả cụ thể hoá thêm (không đổi hướng, chỉ làm rõ ranh giới cho task
code sau):

- `handleVmProvision` (SOL-AG-EVM-002) **không đổi** — vẫn chỉ forward
  `target` nguyên vẹn vào `provisionResult`, không tự dial, không tự giữ
  credential nào (credential material theo quyết định 1 chỉ xuất hiện ở
  RPC dial thật, không xuất hiện ở bước `provision`).
  Vulnerability không sinh ra ở stage duyệt VM — sinh ra đúng lúc user
  thật sự attach.
- RPC method cụ thể kích hoạt dial thật (tên method, request/response
  shape) **chưa đặt tên ở đây** — đó là phạm vi 1 task code
  (TASK-AG-EVM-005+), cần khớp với RPC backend-go phát ra khi
  `AttachWorkspace` xử lý runtime `ssh`-type.

## Liên quan

- `specs/backlog/BACKLOG-001-ephemeralvm-ssh-outbound-client.md`
- `frontend/src/shared/ephemeral-vm-recipes.ts:47-` (`EphemeralVmRecipeSshTargetSchema`)
- `agent/src/main/ssh/ssh-filesystem-stream-reader.ts`, `ssh-git-response-stream-reader.ts` (kiến trúc để mirror, không phải code)
- `specs/agent/tdd/v5/03-connection-modes.md` §1-2
- [SOL-AG-EVM-002](./SOL-AG-EVM-002-vm-provision-streaming-handler.md) (điểm nối)
- [BE-SOL-EVM-004](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md)
