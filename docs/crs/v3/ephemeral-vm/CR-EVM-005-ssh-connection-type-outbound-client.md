# CR-EVM-005 — Ephemeral VM `ssh`-connection-type lifecycle (agent outbound SSH client)

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-EVM-005 |
| **Tên** | Agent trở thành outbound SSH client tới host thứ 3 (VM do recipe provision) |
| **Loại** | New Capability (subsystem lớn) |
| **Priority** | P3 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔲 Proposed — thiết kế sketch, chưa committed |
| **Tác giả** | Kế thừa `docs/backlog/BACKLOG-001-ephemeralvm-ssh-outbound-client.md`, xác nhận lại bằng mã nguồn hiện tại |
| **Tác động HLD** | Agent transport layer (WebSocket modes hiện có), Infra-Fleet domain |
| **Tác động Features** | Ephemeral VM workspace với recipe trả `{type: 'ssh', target}` — hiện bị chặn vĩnh viễn |

---

## Bối cảnh & Vấn đề gốc

`ephemeralVm.*` hỗ trợ 2 kiểu kết nối cho VM đã provision:
`orca-server` (agent binary tự dial vào Orca — [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md)
đưa nhánh này hoạt động) và `ssh` (recipe trả thẳng
host/port/username/identityFile thay vì pairing như 1 dev server Orca
quản lý). Với `ssh`-type, `attachWorkspace`/`suspendWorkspace`/
`resumeWorkspace`/`cleanup` **cố ý** trả lỗi permanent
`INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED` — đây là hành vi đúng, không phải
bug, cho tới khi năng lực dưới đây tồn tại.

**Vì sao bị chặn**: hỗ trợ `ssh`-type nghĩa là Dev Server Agent phải trở
thành **outbound SSH client tới 1 host thứ 4, không liên quan** (target
của recipe) — khác hẳn 2 chế độ WebSocket hiện có của agent tới chính
Orca:

- `agent/src/relay/agent-connection-relay.ts` — Orca dial VÀO agent.
- `agent/src/relay/agent-connection-direct.ts` — agent dial RA Orca.

Không cái nào là SSH client tới bên thứ 3. Xác nhận lại (2026-09-08,
không dựa vào tài liệu cũ): `agent/package.json` có `ssh2`/`@types/ssh2`
trong dependencies, nhưng

```bash
grep -rn "from 'ssh2'" agent/src --include=*.ts | grep -v test
# → không có kết quả nào
```

— toàn bộ `ssh-*.ts` hiện có trong `agent/src` đều implement chiều
**inbound** (agent bị Orca reach tới qua 1 kênh exec SSH đã mở sẵn), không
phải outbound tới bên thứ 3. Kết luận của BACKLOG-001 vẫn đúng nguyên
vẹn ở thời điểm audit này.

## Quyết định (2026-09-08): 2 hướng song song, chọn qua config backend-go

Audit sâu hơn phát hiện `backend-go/services/infra-fleet-service/internal/adapter/sshconn/`+`sshrelay/` — cơ chế **"relay-ssh mode"** có thật, đang chạy cho SSH target user tự đăng ký: backend-go tự dial SSH (Vault-signed cert), SFTP-deploy `agent/out/agent.js`, SSH-exec launch `node agent.js --stdio`, biến host đó thành 1 dev server bình thường. `sshrelay.Provisioner` chỉ phụ thuộc 2 interface hẹp (`Connector.Connect(ctx, domain.SshTarget) (*sshconn.Connection, error)`, `SshTargetResolver.Get(...)`) — không khoá cứng vào Vault-cert auth, nên có thể thay bằng 1 connector khác dùng credential recipe tự cung cấp (identityFile/identityAgent), tái dùng nguyên `sshrelay.Provisioner`'s pipeline deploy/launch/handshake.

Quyết định: **implement cả 2 hướng, chọn qua 1 config setting ở backend-go** (không phải quyết định cứng 1 hướng):

| | Hướng A — Agent outbound SSH client | Hướng B — Backend-go dial + deploy agent |
|---|---|---|
| Ai dial SSH tới VM đích | Dev Server Agent (kênh WebSocket agent↔Orca đã có) | `infra-fleet-service` trực tiếp (tái dùng `sshconn`+`sshrelay`) |
| Credential đi đâu | Vault → RPC param → RAM của agent process | Vault/recipe → chỉ dùng nội bộ backend-go, **không rời backend-go** |
| Code mới ở `agent/` | Subsystem mới hoàn toàn (ssh2 dial, hidden-target registry, 2 fs/git provider) | **Không cần gì** |
| Code mới ở backend-go | Bảng hidden-target, Vault path riêng, `ExecViaHiddenSshTarget`, `hiddenTargetID` xuyên `git-gateway-service` | 1 connector biến thể (auth bằng key recipe cung cấp) + đăng ký dev server bình thường sau khi launch |
| Kết quả sau khi kết nối | Vẫn là "hidden target" riêng biệt, mọi path fs/git cần biết tới nó | Trở thành 1 dev server **bình thường** — mọi RPC hiện có (`terminal.create`, `fs.*`, `git.*`) chạy không đổi |
| Rủi ro bảo mật | Cao hơn (agent giữ private key tạm) | Thấp hơn (key không rời backend-go) |

Cả 2 hướng dùng chung 1 abstraction (`EphemeralVmSshProvisioner` interface) ở `infra-fleet-service`, chọn implementation qua 1 config/env var backend-go (mặc định đề xuất: Hướng B, vì rủi ro bảo mật thấp hơn và tái dùng hạ tầng đã có — nhưng để ops đổi được qua config, không hardcode).

**Rủi ro chung cả 2 hướng, chưa giải quyết ở quyết định này**: `sshconn`'s host-key verification hiện là `InsecureIgnoreHostKey()` (gap đã biết, ghi nhận từ trước, không phải do CR này gây ra) — `EphemeralVmRecipeSshTargetSchema` cũng không có field fingerprint. Áp dụng đúng gap đó cho ephemeral VM (chấp nhận rủi ro MITM ở mức tương đương SSH targets thường hôm nay), không tự thêm verification mới ở đây.

## Giải pháp đề xuất (sketch cho Hướng A, chưa committed — theo đúng khung BACKLOG-001)

1. **SSH2 client integration thật trong `agent/`**, dial tới
   `target` của recipe (host/port/username/identityFile/identityAgent/
   proxyCommand/jumpHost/portForwards — xem
   `frontend/src/shared/ephemeral-vm-recipes.ts`'s
   `EphemeralVmRecipeSshTargetSchema`).
2. **1 registry "hidden target"** tách biệt user-visible SSH targets
   (`infra.ssh_targets`) — kết nối này do recipe provision, không phải
   user tự đăng ký, không nên lẫn vào UI quản lý SSH targets thông
   thường.
3. **fs/git provider dispatch tương đương cho hidden target này**, mirror
   `agent/src/main/ssh/ssh-filesystem-stream-reader.ts`/
   `ssh-git-response-stream-reader.ts` nhưng cho chiều **agent-khởi-tạo
   outbound** thay vì inbound.
4. **Quyết định cách expose fs/git surface của hidden target này qua
   `git-gateway-service`'s repo→host dispatch hiện có** — vì lúc này repo
   thực sự sống trên 1 **máy thứ 5** (VM's SSH target của recipe), không
   phải chính Dev Server đang chạy agent.

Quy mô so sánh được với `desktop/`'s `ipc/ssh.ts` + toàn bộ
provider-dispatch cộng lại — công việc nhiều ngày, không phải wiring
nhanh.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Subsystem hoàn toàn mới, chưa có tiền lệ outbound SSH trong `agent/` | Cao | Không tái dùng được `ssh-filesystem-stream-reader.ts` nguyên xi — chỉ mirror kiến trúc, code thật khác chiều dữ liệu |
| Bảo mật: agent giữ + dùng identity file/agent-forwarding tới host thứ 3 do recipe khai báo | Cao | Cần review bảo mật riêng trước khi bỏ cờ experimental — đây là surface tấn công mới (agent trở thành SSH client với credentials recipe cung cấp) |
| Phụ thuộc lỏng vào [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) | Trung bình | `provision`'s nhánh `{type:'ssh', target}` phải tồn tại trước để có nơi route vào — CR-EVM-003 đã thiết kế để pass-through nhánh này nguyên vẹn, không cần đổi khi CR-EVM-005 ship sau |
| Guard hiện tại (`ephemeral_vm_relay.go`'s `connection_type == "ssh"` check) | Thấp | Đã tồn tại, tiếp tục là nơi giữ an toàn cho tới khi CR này xong — không được gỡ guard này sớm hơn năng lực thật |

## Không thuộc phạm vi CR này

- Nhánh `orca-server` — đã xử lý đầy đủ ở
  [CR-EVM-001](./CR-EVM-001-agent-vm-exec-handler.md)/
  [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md)/
  [CR-EVM-004](./CR-EVM-004-environment-devserver-resolution.md).
- Quản lý SSH targets do user tự đăng ký (`infra.ssh_targets`) — không
  đụng, đây là hidden-target registry riêng.

## Liên quan

- `docs/backlog/BACKLOG-001-ephemeralvm-ssh-outbound-client.md` (thiết kế gốc, CR này hiện thực hoá)
- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (nơi guard `connection_type == "ssh"` sống hôm nay)
- `agent/src/relay/agent-connection-direct.ts`, `agent-connection-relay.ts` (2 chế độ hiện có, để so sánh)
- `frontend/src/shared/ephemeral-vm-recipes.ts` (`EphemeralVmRecipeSshTargetSchema`)
- [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) (nơi nhánh `ssh` được phát hiện và pass-through)
