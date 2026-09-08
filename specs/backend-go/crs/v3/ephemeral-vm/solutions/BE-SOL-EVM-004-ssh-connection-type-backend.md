# BE-SOL-EVM-004: `ssh`-connection-type — phần backend-go

> **🔲 Designed — sketch, chưa committed.** Phần lớn công việc thật của
> [CR-EVM-005](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-005-ssh-connection-type-outbound-client.md)
> nằm ở agent (subsystem SSH2 outbound client mới) — xem
> [SOL-AG-EVM-003](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-003-outbound-ssh-client.md).
> Solution này chỉ phác thảo phần backend-go cần thay đổi **sau khi**
> agent's khả năng đó tồn tại — không tự đủ để implement.

**CR:** [CR-EVM-005](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-005-ssh-connection-type-outbound-client.md)
**Service:** `infra-fleet-service`
**Agent counterpart:** [SOL-AG-EVM-003](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-003-outbound-ssh-client.md)
**TDD tham chiếu:** [`infra-fleet-service.md`](../../../../tdd/services/infra-fleet-service.md) §4 (Domain model — `ssh_targets`), §9 (Security notes)

---

## 1. Guard hiện tại — giữ nguyên cho tới khi agent có khả năng thật

`ephemeral_vm_relay.go`'s `connection_type == "ssh"` check (đúng như ghi
nhận ở [BACKLOG-001](../../../../../backlog/BACKLOG-001-ephemeralvm-ssh-outbound-client.md))
tiếp tục trả `INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED` cho tới khi
[SOL-AG-EVM-003](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-003-outbound-ssh-client.md)
ship — không gỡ guard này sớm hơn năng lực thật tồn tại.

## 2. Khi agent's outbound SSH client tồn tại — hidden-target registry ở backend-go

Theo sketch của CR-EVM-005, cần 1 khái niệm "hidden target" tách biệt
`infra.ssh_targets` (user-visible, `infra-fleet-service.md` §4's domain
model) — vì kết nối này do **recipe** provision, không phải user tự đăng
ký. Đề xuất: 1 bảng mới `infra.ephemeral_vm_ssh_targets` (không tái dùng
`ssh_targets` — khác vòng đời, khác chủ sở hữu ghi, tránh UI quản lý SSH
targets thường lẫn với các target ẩn này), khoá theo `runtime_id` (FK
`ephemeral_vm_runtimes.id`), lưu `host`/`port`/`username`/
`identity_file_vault_path`/... — theo đúng field của
`EphemeralVmRecipeSshTargetSchema` (`frontend/src/shared/ephemeral-vm-recipes.ts:47-`).

**Vault**: theo `infra-fleet-service.md` §9's quy tắc "this service is
one of the few permitted direct Vault callers cho SSH host credential
material" — `identityFile`/`identityAgent` cho hidden target này nên đi
qua cùng cơ chế Vault SSH secrets engine `ssh_targets.auth_vault_path`
đã dùng cho user-visible targets, không lưu plaintext trong Postgres.

## 3. `EphemeralVmRelay`'s 4 method — bỏ guard cho `ssh`, relay qua kênh mới

`AttachWorkspace`/`SuspendWorkspace`/`ResumeWorkspace`/`CleanupWorkspace`
với `connection_type == "ssh"` sẽ relay qua **agent's outbound SSH client
đã dial sẵn** (không phải `DevServerAgentClient.Exec`/`vm.exec` — đó là
kênh WebSocket agent↔Orca, còn lệnh `suspend`/`resume`/`destroy` của
recipe `ssh`-type giờ chạy **trên chính VM đích** qua kết nối SSH agent
vừa mở, không phải trên Dev Server chạy agent). Cần 1 phương thức mới
trên `DevServerAgentClient`, ví dụ `ExecViaHiddenSshTarget(ctx, devServer,
hiddenTargetID, command string)`.

## 4. fs/git surface — quyết định kiến trúc còn mở, không giải quyết ở solution này

CR-EVM-005 mục 4 đã nêu: repo giờ sống trên **máy thứ 5** (VM's SSH
target), không phải Dev Server. `git-gateway-service`'s repo→host
dispatch hiện tại (per `08-inter-service-communication.md`) giả định
repo sống trên Dev Server hoặc local — cần 1 vòng review kiến trúc riêng
để quyết định: (a) mở rộng `ResolveConnection`'s khái niệm "host" để bao
gồm hidden target, hay (b) 1 route dispatch hoàn toàn khác cho trường hợp
này. **Không quyết định trong solution này** — đúng tinh thần CR-EVM-005
"quy mô so sánh được với `desktop/`'s `ipc/ssh.ts` + provider-dispatch
cộng lại".

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng SOL-AG-EVM-003 | Cao | Không có gì để backend-go relay tới nếu agent chưa có outbound SSH client thật |
| Vault ACL cho bảng hidden-target mới | Cao | Cần review theo đúng `06-secrets-vault-architecture.md`'s quy tắc mặc định "no other service talks to Vault directly" — `infra-fleet-service` là ngoại lệ đã ghi nhận cho `ssh_targets`, cần xác nhận ngoại lệ đó áp dụng được cho bảng mới này |
| fs/git dispatch cho máy thứ 5 | Cao, chưa giải | Xem mục 4 — cần quyết định kiến trúc riêng trước khi implement bất kỳ phần nào ở mục 3/4 |

## Không thuộc phạm vi solution này

- Bản thân SSH2 client, dial logic — hoàn toàn ở agent, xem
  [SOL-AG-EVM-003](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-003-outbound-ssh-client.md).
- Nhánh `orca-server` — đã xử lý ở BE-SOL-EVM-001/002/003.

## Quyết định đã chốt (TASK-BE-EVM-009)

> Chốt 3 điểm để mở ở mục 2/4 phía trên. Đối chiếu SOL-AG-EVM-003
> (agent-side sketch) và **phải khớp** với TASK-AG-EVM-004 (agent-side
> design-decision task, chạy song song) cho quyết định 1 — xem cảnh báo
> cuối mục 1.
>
> **✅ Đối chiếu xác nhận khớp (2026-09-08)** — TASK-AG-EVM-004 (agent-side,
> [SOL-AG-EVM-003 §"Quyết định đã chốt"](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-003-outbound-ssh-client.md#quyết-định-đã-chốt-task-ag-evm-004))
> hoàn thành độc lập, chốt đúng cùng cơ chế: RPC param, `infra-fleet-service`
> resolve Vault trước, agent không tự gọi Vault, gắn với `AttachWorkspace`.
> Không có mâu thuẫn — 2 quyết định viết độc lập nhưng tự hội tụ đúng 1
> thiết kế.

### 1. Kênh credential material cho `identityFile`/`identityAgent`

**Chốt: RPC param qua kênh agent↔`infra-fleet-service` hiện có (WS,
`ORCA_AGENT_TOKEN`-authenticated). Agent KHÔNG tự gọi Vault.**

- `infra-fleet-service` (không phải agent) gọi Vault để resolve identity
  material cho hidden target, dùng đúng cơ chế `adapter/vault/` đã có cho
  `ssh_targets.auth_vault_path`: ưu tiên Vault SSH secrets engine (cert
  ngắn hạn) khi target hỗ trợ cert auth, fallback KV v2 static key
  material khi không.
- Material đã resolve được truyền xuống agent như 1 tham số của 1 RPC
  method mới trên kênh agent↔Orca hiện có — ví dụ `vm.sshDial(runtimeID,
  target, resolvedCredential)` — không phải 1 lần fetch riêng agent→Vault.
- Agent giữ material này **chỉ trong bộ nhớ**, dùng 1 lần cho
  `dialOutboundSshTarget` (SOL-AG-EVM-003 §2a), không ghi ra đĩa — khớp
  thiết kế agent-local hidden-target registry ở SOL-AG-EVM-003 §2b (session
  sống trong RAM, mất khi agent restart, không có cơ chế phục hồi tự động).

**Lý do:**

1. Agent là "execution plane" — 1 boundary hệ thống khác hẳn các Go
   service (`08-inter-service-communication.md`: "Dev Server Agent relay
   protocol... a different system boundary entirely"). Agent auth vào Orca
   bằng shared secret `ORCA_AGENT_TOKEN`, không có danh tính Vault.
   `06-secrets-vault-architecture.md`'s Kubernetes auth method giả định
   caller là 1 pod trong cluster — agent chạy trên dev server/máy người
   dùng bất kỳ (kể cả qua SSH relay), không có identity đó, và không CR
   nào trong nhóm ephemeral-vm này đề xuất cấp Vault identity mới cho
   agent. Cho agent gọi thẳng Vault đòi hỏi xây mới toàn bộ auth-vào-Vault
   cho agent — ngoài phạm vi CR-EVM-005 — và mở rộng "ai được nói chuyện
   trực tiếp với Vault" ra khỏi backend-go, ngược nguyên tắc mặc định của
   `06-secrets-vault-architecture.md`.
2. `infra-fleet-service` đã là 1 trong số ít service được phép gọi Vault
   trực tiếp cho SSH host credential material (`infra-fleet-service.md`
   §9). Dùng lại đúng con đường đó cho hidden target không phát sinh Vault
   ACL caller mới — chỉ mở rộng phạm vi path (xem Quyết định 2), không mở
   thêm 1 caller mới vào Vault.
3. Khớp mẫu hình đã có trong `ephemeral_vm_relay.go`: `command` (recipe's
   suspend/resume/destroy) đã truyền như RPC param qua đúng kênh này
   (`callAgent(ctx, devServer, "vm.exec", map[string]any{...})`).
   Credential material cho dial đi theo cùng mẫu — không phát minh kênh
   thứ 2 chỉ cho riêng use case này.

**⚠️ Cần đối chiếu 2 phía — TASK-AG-EVM-004.** SOL-AG-EVM-003 §2a để ngỏ
đúng câu hỏi này ("cơ chế cụ thể — tham số RPC hay 1 lần fetch riêng — là
quyết định thiết kế cần chốt trước khi implement"). Quyết định ở đây giả
định agent **nhận** material qua RPC param, không tự fetch. Nếu
TASK-AG-EVM-004 (đang chạy song song, quyết định phía agent) chốt khác đi
(agent tự fetch Vault, hoặc 1 kênh thứ 3), 2 bên phải được review lại
cùng nhau trước khi bất kỳ task code nào (backend-go hay agent) bắt đầu
implement dial logic — đây là điểm phối hợp bắt buộc giữa 2 task quyết
định chạy song song.

### 2. Phạm vi ngoại lệ Vault-direct-call cho `infra.ephemeral_vm_ssh_targets`

**Chốt: mở rộng đúng ngoại lệ đã ghi nhận cho `infra-fleet-service`
(`infra-fleet-service.md` §9) sang bảng mới — không tạo ngoại lệ mới,
không tái dùng chung Vault path với `ssh_targets`.**

- `infra.ephemeral_vm_ssh_targets.identity_file_vault_path` (và tương
  đương cho `identityAgent`) nằm **trong** phạm vi ngoại lệ hiện có: cùng
  service (`infra-fleet-service`), cùng domain (SSH host credential
  material), cùng Vault engine (SSH secrets engine ưu tiên, KV v2
  fallback), cùng access pattern (resolve tại thời điểm connection-
  establish/dial, giữ trong bộ nhớ, không persist plaintext) như
  `ssh_targets.auth_vault_path` đã được ghi nhận.
- Vault path phải **tách biệt** khỏi path của `ssh_targets` (ví dụ
  `secret/data/infra-fleet/ephemeral-vm-ssh-targets/<runtime_id>` thay vì
  tái dùng `secret/data/infra-fleet/ssh-targets/*`) — khớp lý do
  BE-SOL-EVM-004 §2 đã nêu cho việc không tái dùng bảng Postgres
  `ssh_targets` (khác vòng đời, khác chủ sở hữu ghi: recipe-provisioned
  vs. user-registered). Audit trail và revocation của 2 loại target không
  nên lẫn vào nhau dù cùng 1 Vault ACL policy caller.
- Vault policy cho `infra-fleet-service`'s Vault identity cần grant thêm
  prefix mới này (bên cạnh prefix `ssh_targets` đã có) — đây là việc của
  task code hạ tầng/Vault policy (không phải task này), nhưng **được xác
  nhận nằm trong scope hợp lệ** ở quyết định này, không cần review kiến
  trúc riêng thêm lần nữa trước khi viết policy đó.

**Lý do:** `06-secrets-vault-architecture.md`'s nguyên tắc mặc định "no
other service talks to Vault directly for secret material" đã có ngoại lệ
ghi nhận rõ cho `infra-fleet-service` + SSH host credential material —
đây đúng là loại dữ liệu bảng mới này lưu (không phải "tenant/user secret
material" như OAuth token/AI key mà quy tắc đó nhắm tới). Mở rộng 1 ngoại
lệ đã duyệt sang 1 bảng cùng domain, cùng service sở hữu, là nhất quán —
không phải khoét thêm 1 lỗ hổng chính sách mới. `infra-fleet-service.md`
dòng ~383-386's TODO ("cần xác nhận trước khi finalize Vault ACL policy")
coi như được xác nhận bởi quyết định này cho phần mở rộng sang bảng hidden-
target; cập nhật TODO đó (xoá cờ "chưa xác nhận", nêu rõ phạm vi 2 bảng)
là việc của task code liên quan, không sửa ở đây để giữ đúng ranh giới
"task quyết định, không code" của TASK-BE-EVM-009.

### 3. Route dispatch fs/git cho "máy thứ 5"

**Chốt: route dispatch riêng bên trong `git-gateway-service`
(phương án (b) — KHÔNG mở rộng khái niệm "host" của `ResolveConnection`).**

- `ResolveConnection`'s hợp đồng giữ nguyên: `connectionId` → đúng 1
  `DevServer` (domain invariant hiện có, `infra-fleet-service.md` §4: "a
  `connectionId` resolves to exactly one `DevServer` at a time"). Với
  runtime `ssh`-type, `DevServer` đích của `ResolveConnection` vẫn là Dev
  Server đang chạy agent — vì đó vẫn là process/socket thật mà
  `git-gateway-service` phải mở kết nối tới; hidden target không có kênh
  transport riêng, nó chỉ reachable qua session SSH agent vừa dial ra
  (SOL-AG-EVM-003 §2a/§2b). Kéo hidden target vào bên trong khái niệm
  "host" của `ResolveConnection` sẽ phá invariant 1-connectionId-1-
  DevServer (thực chất sẽ là 1-connectionId-2-host tuỳ loại operation),
  đổi ngữ nghĩa của 1 API mọi service khác (`project-service`, `api-gateway`)
  đang phụ thuộc.
- Thay vào đó: 1 thuộc tính định tuyến mới, trực giao với `connectionId`
  — `hiddenTargetID` (= ephemeral VM `runtimeID`) — được truyền kèm bất cứ
  đâu `RepoPath` đã được truyền hôm nay (ví dụ mở rộng
  `resolveDevServerAndRepoPath`'s call site, hoặc entity project/workspace
  đang giữ `RepoPath`), mặc định rỗng cho mọi repo sống trực tiếp trên Dev
  Server như hiện tại. `hiddenTargetID` là thuộc tính của **repo/workspace**
  ("repo này sống ở đâu"), không phải thuộc tính của **connection**
  ("kênh transport nào") — 2 khái niệm khác nhau, không nên gộp vào cùng 1
  trường resolve.
- `git-gateway-service`'s `git.*`/`fs.*` dispatch: khi `hiddenTargetID` có
  giá trị, vẫn mở/dùng lại **đúng** `DevServerAgentClient` connection tới
  Dev Server như bình thường (không có transport layer mới, không có giá
  trị `provider_registry_entries` mới ở tầng connection) — nhưng gọi 1 tập
  method agent mới (mirroring `ExecViaHiddenSshTarget` đã phác thảo ở mục
  3, ví dụ `fs.readViaHiddenTarget`/`git.statusViaHiddenTarget`) mang theo
  `hiddenTargetID`, báo cho agent route qua session outbound SSH trong
  registry SOL-AG-EVM-003 §2b thay vì thực thi trên filesystem cục bộ của
  Dev Server.
- `provider_registry_entries`'s enum hiện có (`local`/`ssh-backed`/
  `dev-server-agent-backed`) **không đổi** — bảng này ghi nhận resolution
  cho cả bộ ba PTY/fs/git của 1 connection; PTY session tới chính Dev
  Server không bị ảnh hưởng bởi hidden target, chỉ riêng fs/git call cho
  workspace của runtime đó cần định tuyến lại. Thêm 1 giá trị enum mới sẽ
  ngụ ý sai rằng cả connection đổi transport.

**Lý do:** đây là quyết định kiến trúc lớn nhất trong 3 mục (đúng như
BE-SOL-EVM-004 §4 đã gắn cờ), nhưng domain invariant đã document sẵn ở
`infra-fleet-service.md` §4 cho câu trả lời rõ ràng — mở khái niệm "host"
để bao gồm 1 hop gián tiếp qua agent sẽ phá vỡ 1 hợp đồng nhiều service
khác đang dựa vào, trong khi thêm 1 trường định tuyến trực giao
(`hiddenTargetID`) đạt cùng mục tiêu (route fs/git operations tới máy thứ
5) mà không đổi ngữ nghĩa bất kỳ API hiện có nào. Đây cũng là hướng khớp
tự nhiên với `ExecViaHiddenSshTarget` mà BE-SOL-EVM-004 §3 đã tự phác thảo
cho method mới trên `DevServerAgentClient` — dùng chung mẫu tham số
`hiddenTargetID` cho cả PTY-lifecycle path (mục 3) lẫn fs/git path (mục 4)
thay vì 2 cơ chế định tuyến khác nhau cho cùng 1 khái niệm.

## 5. Hướng B (mới, 2026-09-08) — tái dùng `sshconn`/`sshrelay`, config-selected

Xem [CR-EVM-005 §"Quyết định (2026-09-08)"](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-005-ssh-connection-type-outbound-client.md#quyết-định-2026-09-08-2-hướng-song-song-chọn-qua-config-backend-go)
cho so sánh đầy đủ. Chi tiết kỹ thuật:

### 5a. `EphemeralVmSshProvisioner` — abstraction chung cho cả 2 hướng

```go
// internal/usecase/ports.go (bổ sung)
type EphemeralVmSshProvisioner interface {
  // Provision dials target, gets a reachable Dev Server Agent connection
  // established for it (however the strategy achieves that), and returns
  // the resulting connectionID — a real infra.connections row, ready for
  // ResolveConnection like any other dev server.
  Provision(ctx context.Context, tenantID, runtimeID string, target domain.EphemeralVmSshTarget) (connectionID string, err error)
}
```

Config chọn implementation (env var, mirror `LoadConfigFromEnv` pattern có sẵn):

```go
// EPHEMERAL_VM_SSH_MODE=agent-outbound | backend-relay-deploy (mặc định: backend-relay-deploy)
```

### 5b. Implementation Hướng B — `backendrelaysshprovisioner`

Tái dùng `sshrelay.Provisioner` nguyên vẹn, chỉ thay 2 input:

1. **`domain.EphemeralVmSshTarget`** (type MỚI, KHÔNG phải `domain.SshTarget`) —
   `domain.SshTarget`'s constructor cố tình bắt buộc `VaultSSHRole`
   ("this service never stores raw key material" — invariant đúng cho bảng
   `ssh_targets` PERSISTED). Ephemeral target không persist gì, chỉ sống
   trong 1 lần gọi `Provision` — không vi phạm invariant đó, cần type riêng:
   ```go
   type EphemeralVmSshTarget struct {
     Host, Port, Username string
     PrivateKeyPEM string   // từ recipe's identityFile, resolve qua Vault (xem §5c)
     IdentityAgentSocket string  // optional, local ssh-agent path — KHÔNG qua Vault
     JumpHost, ProxyCommand string  // optional
   }
   ```
2. **1 connector mới** implement đúng `sshrelay.Connector` interface
   (`Connect(ctx, target) (*sshconn.Connection, error)` — interface hẹp,
   KHÔNG khoá vào `domain.SshTarget` cụ thể, xác nhận đọc source thật):
   ```go
   // internal/adapter/ephemeralsshconn/connector.go (MỚI)
   func (c *Connector) Connect(ctx context.Context, target domain.EphemeralVmSshTarget) (*sshconn.Connection, error) {
     var authMethod ssh.AuthMethod
     if target.IdentityAgentSocket != "" {
       authMethod = sshAgentAuthMethod(target.IdentityAgentSocket)  // net.Dial unix socket + agent.NewClient
     } else {
       signer, _ := ssh.ParsePrivateKey([]byte(target.PrivateKeyPEM))
       authMethod = ssh.PublicKeys(signer)
     }
     client, err := ssh.Dial("tcp", fmt.Sprintf("%s:%d", target.Host, target.Port), &ssh.ClientConfig{
       User: target.Username, Auth: []ssh.AuthMethod{authMethod},
       HostKeyCallback: ssh.InsecureIgnoreHostKey(), // cùng gap đã biết, không tự thêm verification mới
     })
     // jumpHost/proxyCommand: cùng kỹ thuật double-hop (sock/forwardOut) đã
     // sketch cho agent-side ở SOL-AG-EVM-003 §2, port sang Go's golang.org/x/crypto/ssh
     return sshconn.WrapClient(client), nil  // constructor MỚI, xem §5d
   }
   ```
3. **`sshrelay.Provisioner.Provision(ctx, devServer)` cần 1 `domain.DevServer` với `ssh_target_id`** — với ephemeral target, tạo 1 `domain.DevServer` **tạm, không persist** trước khi gọi (không cần bảng `ssh_targets`/`dev_servers` thật cho bước dial+deploy — chỉ cần đăng ký thật SAU KHI `Provision` thành công, xem §5c). Cần xác nhận `Provisioner.Provision`'s dependency thật vào `domain.DevServer` (đọc `sshrelay/provisioner.go:82-114` kỹ hơn ở task code — sketch ở đây theo interface đã audit, chưa đọc hết body).

### 5c. Sau khi launch thành công — đăng ký như 1 dev server bình thường + `environment_id`

Khác Hướng A hoàn toàn: không cần bảng hidden-target, không cần `hiddenTargetID` xuyên `git-gateway-service` — vì sau bước `sshrelay.Provisioner.Provision` thành công, host đó **là** 1 dev server thật (`devserveragent.Transport` + `HandshakeInfo` chuẩn, y hệt kết quả relay-ssh mode cho SSH targets thường). Đăng ký `dev_servers` row + `connections` row theo đúng path hiện có (mirror `RegisterDevServer`), rồi **backend-go tự set `environment_id = runtimeID` ngay lập tức** (không cần cơ chế correlation phức tạp như TASK-BE-EVM-011 đã phải giải quyết cho Hướng orca-server — ở đây backend-go chính là bên khởi tạo kết nối, biết `runtimeID` từ đầu, không có độ trễ/sự kiện async tách biệt nào).

Credential (`PrivateKeyPEM`) resolve từ Vault theo đúng quyết định 2 đã chốt (§2 phía trên, mở rộng ngoại lệ Vault-direct-call hiện có) — **khác Hướng A**: material này KHÔNG BAO GIỜ rời khỏi tiến trình `infra-fleet-service`, dùng xong drop khỏi bộ nhớ ngay sau `Connect()`.

### 5d. `sshconn` package cần 1 constructor export mới — thay đổi tối thiểu, không invasive

`sshconn.Connection`'s field hiện tại unexported — `ephemeralsshconn.Connector` (khác package) cần 1 cách build `*sshconn.Connection` từ 1 `*ssh.Client` đã dial xong (bằng auth method khác, không qua `sshconn.Connector.Connect`'s Vault-cert flow). Thêm:

```go
// sshconn/connector.go (bổ sung, KHÔNG đổi Connect() hiện có)
func WrapClient(client *ssh.Client) *Connection { return &Connection{client: client} }
```

Đây là thay đổi duy nhất cần trong `sshconn` package hiện có — mọi thứ khác (`sshrelay.Provisioner`, `deploy`/`launch`) dùng lại nguyên vẹn.

## Liên quan

- `docs/backlog/BACKLOG-001-ephemeralvm-ssh-outbound-client.md`
- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (guard hiện tại)
- `backend-go/services/infra-fleet-service/internal/adapter/sshconn/connector.go` (Hướng B tái dùng)
- `backend-go/services/infra-fleet-service/internal/adapter/sshrelay/provisioner.go` (Hướng B tái dùng nguyên vẹn)
- `specs/backend-go/tdd/services/infra-fleet-service.md` §4, §9
- `specs/backend-go/tdd/architecture/06-secrets-vault-architecture.md`
- `frontend/src/shared/ephemeral-vm-recipes.ts:47-` (`EphemeralVmRecipeSshTargetSchema`)
