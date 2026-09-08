# Ephemeral VM — Change Requests (v3)

> **Bối cảnh:** `ephemeralVm.*` quản lý VM/container dùng-một-lần theo từng
> workspace, dựng từ "recipe" do chính repo định nghĩa (`orca.yaml`'s
> `environmentRecipes` — 4 command string `create`/`suspend`/`resume`/
> `destroy`, xem [`specs/backend/api/ephemeral-vm-server-mode-design.md`](../../../../specs/backend/api/ephemeral-vm-server-mode-design.md)
> cho phần "What ephemeral VM actually means"). Tính năng này đang ở trạng
> thái **lưng chừng có chủ đích lẫn ngoài ý muốn**: phần lớn 9 method
> request/response đã được port sang `backend-go` (SOL-004/TASK-004/
> TASK-005, `specs/backend-go/bugs/missing-v3/`), nhưng khi audit trực
> tiếp mã nguồn hiện tại (2026-09-08) để chuẩn bị 5 CR dưới đây, phát hiện
> **3 lỗ hổng thật, đang chạy sai** mà không tài liệu nào trước đó ghi
> nhận đầy đủ — xem "Phát hiện mới" bên dưới. 5 CR này là kế hoạch đưa
> `ephemeralVm` hoạt động đúng, đầy đủ ở cả 3 tầng: `frontend`,
> `backend-go`, `agent`.

| CR | Vấn đề | Đề xuất | Tầng | Priority | Status |
|----|--------|---------|------|----------|--------|
| [CR-EVM-001](./CR-EVM-001-agent-vm-exec-handler.md) | `backend-go` đã gọi `vm.exec` tới agent cho suspend/resume/cleanup có command thật — nhưng **agent không có handler nào cho `vm.exec`** → luôn lỗi `INFRA_EPHEMERAL_VM_UNSUPPORTED` | Thêm `agent-ephemeral-vm-handler.ts`, tái dùng `runRecipeCommand` đã có sẵn trong `agent/src/shared/` | `agent` | **P0** | 🔲 Proposed |
| [CR-EVM-002](./CR-EVM-002-remove-stale-desktop-only-suppressor.md) | Frontend vẫn liệt `ephemeralVm` vào `DESKTOP_ONLY_NAMESPACES` (nuốt âm thầm mọi lỗi RPC như "expected") dù `backend-go` đã serve thật 9/12 method từ SOL-004/TASK-005 | Gỡ khỏi suppressor, audit lại toàn bộ 9 method đã port cho target web/paired | `frontend` | P1 | 🔲 Proposed |
| [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) | `ephemeralVm.provision`/`cancelProvision`/`onProvisionEvent` chưa tồn tại ở `backend-go` — lý do bị hoãn năm 2026-08 ("cần `defineStreamingMethod`, backend-go chưa có") **không còn đúng nữa** | Dùng `Registry.StreamChannelHandler` (đã có, đã chạy thật ở `onboarding.openGhAuthTerminal`) để build `provision` như 1 stream channel; agent thêm khả năng stream stdout/stderr thay vì chỉ trả JSON 1 lần | `backend-go` + `agent` + `frontend` | **P0** | 🔲 Proposed |
| [CR-EVM-004](./CR-EVM-004-environment-devserver-resolution.md) | `terminal.create`/`files.browseServerDir` không tự resolve được `environmentId` bare → `ephemeral_vm_runtimes.environment_id` chưa từng được ghi | Ghi `environment_id = dev_server_id` khi `provision` pairing thành công (CR-EVM-003); dùng `ResolveConnectionRequest`'s `dev_server_id` alternate-key đã có sẵn | `backend-go` | P2 | 🔲 Proposed |
| [CR-EVM-005](./CR-EVM-005-ssh-connection-type-outbound-client.md) | Recipe kiểu `ssh` bị chặn vĩnh viễn (`INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED`) — agent chưa có khả năng làm outbound SSH client tới host thứ 3 | Xây `agent/`'s SSH2 outbound client + hidden-target registry + fs/git provider dispatch mới | `agent` + `backend-go` | P3 | 🔲 Proposed |

## Phát hiện mới (audit 2026-09-08, chưa từng ghi nhận đầy đủ trước đây)

1. **`vm.exec` là lỗi runtime thật hôm nay, không phải "chưa implement".**
   `EphemeralVmRelay.SuspendWorkspace`/`ResumeWorkspace`/`CleanupWorkspace`
   (`backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go:98,121,152`)
   đã gọi `uc.agent.Exec(ctx, devServer, "vm.exec", ...)` thật — nhưng
   `agent/src/relay/agent-rpc-dispatch-misc.ts`'s switch-case không có
   `case 'vm.exec'` nào, và không file `agent-ephemeral-vm-handler.ts` nào
   tồn tại. Mọi recipe có `suspend`/`resume`/`destroy` command **luôn thất
   bại** ngay khi được attach vào 1 dev server thật — xem CR-EVM-001.
2. **Frontend đang nuốt âm thầm lỗi thật, tưởng là "desktop-only".**
   `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts:72`
   vẫn liệt `'ephemeralVm'` vào `DESKTOP_ONLY_NAMESPACES`, dù comment đầu
   file (dòng 23) tự ghi rõ: "the moment either backend actually ports
   this namespace, remove it from this set" — điều đó đã xảy ra
   (`channels_ephemeral_vm.go` phục vụ thật 9/12 method). Bất kỳ lỗi thật
   nào (kể cả CR-EVM-001's `INFRA_EPHEMERAL_VM_UNSUPPORTED`) hiện bị dập
   tắt như thể là chuyện bình thường — xem CR-EVM-002.
3. **Kết luận "cần `defineStreamingMethod`, backend-go chưa có" của
   `ephemeral-vm-server-mode-design.md` (viết 2026-08-16) đã lỗi thời.**
   `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:63-95`
   đã có `StreamChannelHandler`/`RegisterStreamChannel`/
   `DispatchStreamChannel` — 1 channel vừa ack vừa mở push-subscription,
   đúng shape `provision` cần. Đã có tiền lệ chạy thật:
   `onboarding.openGhAuthTerminal`
   (`channels_onboarding.go:639-701`) ack `{ptyId, devServerId}` rồi stream
   `terminal.output`/`terminal.exited` qua cùng cơ chế. `provision` không
   còn là "out of scope chờ hạ tầng" nữa — xem CR-EVM-003.

## Nguyên tắc thiết kế xuyên suốt

1. **Không phát minh transport mới.** CR-EVM-003 tái dùng nguyên xi
   `Registry.StreamChannelHandler` đã chạy thật cho
   `onboarding.openGhAuthTerminal`/`terminal.multiplex` — không thêm
   WebSocket phụ, không thêm cơ chế polling.
2. **Tái dùng logic exec đã có ở `agent/src/shared/`.**
   `ephemeral-vm-recipe-process.ts`'s `runRecipeCommand` đã hỗ trợ sẵn
   `onStdout`/`onStderr` chunk callback và `signal: AbortSignal` — đúng
   nguyên liệu CR-EVM-001 (one-shot) và CR-EVM-003 (streaming) cần, không
   viết lại logic spawn/kill process.
3. **`connection_type` (`orca-server` vs `ssh`) tiếp tục là ranh giới rõ
   ràng.** CR-EVM-001/002/003/004 chỉ nhắm `orca-server` (đã có hạ tầng
   pairing qua `agent-connection-direct.ts`). `ssh`-type tiếp tục trả lỗi
   permanent, đúng thiết kế hiện tại, cho tới khi CR-EVM-005 xong — không
   CR nào trong 4 CR đầu được phép âm thầm "mở khoá" nhánh `ssh` nửa vời.
4. **Không đổi opaque JSON contract.** `OrcaVmRecipe`/
   `EphemeralVmRecipeResultSchema`/`EphemeralVmRecipeSshTargetSchema`
   (`frontend/src/shared/ephemeral-vm-recipes.ts`) là type dùng chung
   `frontend/`, `agent/`, `backend-go` (`backend-go` chỉ lưu JSON blob,
   không decode field-by-field) — không CR nào đổi các type này.

## Thứ tự thực thi & phụ thuộc

```
CR-EVM-001 → độc lập hoàn toàn, sửa 1 lỗi runtime đang chạy sai ngay hôm
             nay cho orca-server connection type đã "ship" — làm NGAY,
             P0, không phụ thuộc CR nào khác trong nhóm này
CR-EVM-002 → độc lập hoàn toàn, 1 dòng đổi + audit — làm song song
             CR-EVM-001, không phụ thuộc gì
CR-EVM-003 → nền tảng lớn nhất (StreamChannelHandler mới + agent streaming
             exec + registry cancel) — không phụ thuộc 001/002, nhưng nên
             làm sau khi CR-EVM-001 xong vì dùng chung
             agent-ephemeral-vm-handler.ts (tách handler theo phase
             create/suspend/resume/destroy trong cùng 1 file, xem
             CR-EVM-003's "Liên quan")
CR-EVM-004 → phụ thuộc CỨNG vào CR-EVM-003 (cần provision pairing thành
             công để có gì mà ghi vào environment_id) — làm SAU CÙNG
             trong 4 CR đầu
CR-EVM-005 → độc lập kỹ thuật (agent outbound-SSH là 1 subsystem mới,
             không đụng orca-server path), nhưng chỉ có ý nghĩa product
             sau khi CR-EVM-003's provision flow tồn tại để route vào
             nhánh {type:'ssh', target} — làm sau, không chặn 001-004
```

## Rủi ro chung cần lưu ý trước khi triển khai bất kỳ CR nào

- **Đây vẫn là tính năng experimental, gated bởi
  `settings.experimentalEphemeralVms`** (`frontend/src/shared/types.ts:3008`,
  default `false`) — không CR nào trong nhóm này thay đổi việc gating đó;
  đối tượng ảnh hưởng vẫn chỉ là người dùng đã tự bật cờ.
- **`vm.exec`/`vm.provision` chạy shell command tuỳ ý do repo author viết**
  (kế thừa toàn bộ môi trường/credentials của máy Dev Server) — đúng class
  rủi ro blast-radius mà `EphemeralVmRelay`'s doc comment đã nêu (giống
  `EmulatorRelay`/browser driving). CR-EVM-001/003 không nới thêm rủi ro
  này (chỉ hiện thực hoá đúng behavior recipe đã khai báo), nhưng cần
  review bảo mật riêng trước khi bỏ cờ experimental.
- **`ssh`-type (CR-EVM-005) là subsystem lớn, so sánh về quy mô với
  `desktop/`'s `ipc/ssh.ts` + provider-dispatch cộng lại** — không nên bắt
  đầu trước khi CR-EVM-001..004 đã ổn định, tránh 2 mảng công việc lớn
  chạy song song trên cùng 1 usecase (`EphemeralVmRelay`).
