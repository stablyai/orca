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
>
> **Cập nhật 2026-09-09 — CR-EVM-001..005 đã ✅ Done.** Audit lại mã
> nguồn (khác ngày so với audit gốc) xác nhận cả 5 CR được code trong 2
> commit cùng ngày CR được viết: `80ffe57cd` ("feat(ephemeral-vm):
> implement CR-EVM-001..005 end-to-end (frontend/backend-go/agent)", 584
> file, +78743) và `591de6951` ("fix(ephemeral-vm): resolve 4 real gaps
> found after CR-EVM-005 shipped", 47 file). Không có thay đổi
> ephemeral-vm nào sau 2 commit đó tính đến hôm nay. Xem note "Cập nhật
> 2026-09-09" trong từng file CR-EVM-001..005 để biết bằng chứng cụ thể.
> **CR-EVM-006 → 011 dưới đây là phần audit mới, chưa triển khai** — các
> gap không nằm trong phạm vi 5 CR đầu (đã đóng), tìm thấy khi audit lại
> so với spec F18 đầy đủ.

| CR | Vấn đề | Đề xuất | Tầng | Priority | Status |
|----|--------|---------|------|----------|--------|
| [CR-EVM-001](./CR-EVM-001-agent-vm-exec-handler.md) | `backend-go` đã gọi `vm.exec` tới agent cho suspend/resume/cleanup có command thật — nhưng **agent không có handler nào cho `vm.exec`** → luôn lỗi `INFRA_EPHEMERAL_VM_UNSUPPORTED` | Thêm `agent-ephemeral-vm-handler.ts`, tái dùng `runRecipeCommand` đã có sẵn trong `agent/src/shared/` | `agent` | **P0** | ✅ Done |
| [CR-EVM-002](./CR-EVM-002-remove-stale-desktop-only-suppressor.md) | Frontend vẫn liệt `ephemeralVm` vào `DESKTOP_ONLY_NAMESPACES` (nuốt âm thầm mọi lỗi RPC như "expected") dù `backend-go` đã serve thật 9/12 method từ SOL-004/TASK-005 | Gỡ khỏi suppressor, audit lại toàn bộ 9 method đã port cho target web/paired | `frontend` | P1 | ✅ Done |
| [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) | `ephemeralVm.provision`/`cancelProvision`/`onProvisionEvent` chưa tồn tại ở `backend-go` — lý do bị hoãn năm 2026-08 ("cần `defineStreamingMethod`, backend-go chưa có") **không còn đúng nữa** | Dùng `Registry.StreamChannelHandler` (đã có, đã chạy thật ở `onboarding.openGhAuthTerminal`) để build `provision` như 1 stream channel; agent thêm khả năng stream stdout/stderr thay vì chỉ trả JSON 1 lần | `backend-go` + `agent` + `frontend` | **P0** | ✅ Done |
| [CR-EVM-004](./CR-EVM-004-environment-devserver-resolution.md) | `terminal.create`/`files.browseServerDir` không tự resolve được `environmentId` bare → `ephemeral_vm_runtimes.environment_id` chưa từng được ghi | Ghi `environment_id = dev_server_id` khi `provision` pairing thành công (CR-EVM-003); dùng `ResolveConnectionRequest`'s `dev_server_id` alternate-key đã có sẵn | `backend-go` | P2 | ✅ Done |
| [CR-EVM-005](./CR-EVM-005-ssh-connection-type-outbound-client.md) | Recipe kiểu `ssh` bị chặn vĩnh viễn (`INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED`) — agent chưa có khả năng làm outbound SSH client tới host thứ 3 | Xây `agent/`'s SSH2 outbound client + hidden-target registry + fs/git provider dispatch mới | `agent` + `backend-go` | P3 | ✅ Done |
| [CR-EVM-006](./CR-EVM-006-wire-recipe-doctor.md) | `doctorEphemeralVmRecipe`/`ephemeralVm.doctor` đã có backend + client wrapper thật, nhưng **không nơi nào trong sản phẩm gọi tới nó** — recipe conflict validation là dead capability | Gọi `doctor` trước "Use in workspace" (`EphemeralVmRecipeRow.tsx`) và/hoặc trước `provision()`, hiển thị conflict như dialog block/warn-and-confirm | `frontend` | P2 | 🔲 Proposed |
| [CR-EVM-007](./CR-EVM-007-gate-runtimes-section-experimental-flag.md) | `EphemeralVmRuntimesSection.tsx` mount không điều kiện ở `RuntimeEnvironmentsPane.tsx:998`, gọi `ephemeralVm.listRuntimes()` mỗi lần user mở Settings → Runtime Environments — bất kể `experimentalEphemeralVms` — trong khi mọi entry point ephemeral-vm khác đều gate đúng | Thêm flag check giống pattern `EphemeralVmsExperimentalSetting.tsx`/`sleep-worktree-flow.ts` đã dùng | `frontend` | P2 | 🔲 Proposed |
| [CR-EVM-008](./CR-EVM-008-ssh-target-port-forwards.md) | `EphemeralVmRecipeSshTargetSchema.portForwards` được schema chấp nhận nhưng bị bỏ qua có chủ đích ở 2 điểm decode (`ports.go:497`, `client.go:704`, comment "deliberately omitted") — không agent-side dial code nào áp dụng forward | Thêm field vào proto, implement forward ở cả Hướng A (`ssh-outbound-client.ts`) và Hướng B (`ephemeralsshconn`/`backendrelaysshprovisioner`) | `agent` + `backend-go` | P2 | 🔲 Proposed |
| [CR-EVM-009](./CR-EVM-009-worktree-mount-copy-out-reconciliation.md) | F18 spec mô tả "worktree được mount trong VM, kết quả copy ra sau khi xong" — mô hình đã ship thực tế là "trỏ workspace vào folder recipe's project root sẵn có trong VM", không mount/copy-out nào tồn tại — lệch hẳn spec, không phải thiếu 1 phần | Quyết định sản phẩm: xác nhận mô hình hiện tại là v1 chủ đích (→ CR trở thành spec-correction) hay cần mount/copy-out thật (→ CR trở thành feature lớn) | `frontend` + `agent` (+ `backend-go` nếu chọn xây thật) | P2 | 🔲 Proposed |
| [CR-EVM-010](./CR-EVM-010-auto-destroy-on-task-completion.md) | Tiêu chí chấp nhận F18 "VM bị destroy tự động sau khi task xong" chưa đạt — destroy/cleanup chỉ có qua hành động thủ công (nút Cleanup) hoặc khi workspace/repo bị xoá; không hook nào từ "agent run hoàn thành" tới suspend/destroy | Nối sự kiện agent-run-hoàn-thành (nếu đã tồn tại nơi khác trong hệ thống — khảo sát trước) vào `suspendRuntimeEphemeralVmWorkspace`/`cleanupRuntimeEphemeralVmWorkspace` | `frontend` (+ `agent` nếu cần signal mới) | P2 | 🔲 Proposed |
| [CR-EVM-011](./CR-EVM-011-container-runtime-type.md) | F18's "Runtime Options" liệt Container (Docker/OCI) như lựa chọn thay thế SSH — `connection_type`/`EphemeralVmRuntimeConnectionModeSchema` hiện chỉ có 2 giá trị `'orca-server' \| 'ssh'`, không 1 dòng code nào cho container | Thêm `connection_type: 'container'` end-to-end (schema, proto, backend-go dispatch, agent exec-in-container, UI) — **cần quyết định sản phẩm xác nhận nhu cầu thật trước khi code**, theo đúng thận trọng CR-EVM-005 gốc đã áp dụng cho nhánh SSH | `frontend` + `agent` + `backend-go` | P3 (backlog, chờ xác nhận nhu cầu) | 🔲 Proposed — chưa xác nhận scope |

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

## Phát hiện mới (audit 2026-09-09, sau khi xác nhận CR-EVM-001..005 đã Done)

1. **`doctor` là capability mồ côi.** Channel `ephemeralVm.doctor` chạy
   thật (`backend-go/.../channels_ephemeral_vm.go:64`), client wrapper
   renderer cũng có (`runtime-ephemeral-vm-client.ts:91-96`) — nhưng
   `grep` mọi call site không-phải-test của `.doctor(`/`ephemeralVm.doctor`
   chỉ khớp chính định nghĩa wrapper. Tiêu chí chấp nhận F18 "Recipe
   validation phát hiện conflicts trước khi tạo VM" **không đạt**, dù hạ
   tầng đã sẵn sàng 100% — xem CR-EVM-006.
2. **`portForwards` bị bỏ có chủ đích, ghi rõ trong comment, nhưng chưa
   từng có CR nào theo dõi việc đó.** `backend-go/.../usecase/ports.go:497`
   và `backend-go/.../devserveragent/client.go:704` đều có comment
   "configHost/portForwards deliberately omitted, see
   infrafleet.proto's EphemeralVmRecipeSshTarget message doc comment" —
   quyết định hoãn này chưa từng được ghi vào 1 CR để theo dõi tới khi
   làm — xem CR-EVM-008.
3. **"Integration với Worktrees" (F18 spec) không khớp mô hình đã ship,
   không phải "làm 1 phần rồi dừng".** Spec mô tả mount-in/copy-out;
   thực tế `ephemeral-vm-workspace-target.ts:42-142` trỏ workspace thẳng
   vào folder recipe tự tạo sẵn trong VM (`getEphemeralVmRecipeResultProjectRoot`)
   — 2 mô hình khác nhau về bản chất, không phải điểm A đang đi tới điểm
   B. Cần quyết định sản phẩm trước khi coi đây là "bug" hay "spec cũ
   cần sửa" — xem CR-EVM-009.
4. **`EphemeralVmRuntimesSection.tsx` là điểm gate flag duy nhất bị bỏ
   sót**, giữa nhiều nơi khác đều gate đúng và thậm chí có comment cảnh
   báo tường minh (`sleep-worktree-flow.ts:150-157`,
   `sidebar-worktree-activation.ts:18-27` — cả 2 đều ghi chú lý do phải
   check flag qua Settings chứ không chỉ `window.api?.ephemeralVm`, vì
   preload's fallback Proxy làm namespace đó luôn truthy) — xem
   CR-EVM-007.

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

── nhóm 006-011 (audit 2026-09-09, sau khi 001-005 đã Done) ──────────────

CR-EVM-006 → độc lập, chỉ frontend — làm bất cứ lúc nào
CR-EVM-007 → độc lập, 1 điểm sửa nhỏ — làm bất cứ lúc nào, ưu tiên cao vì
             rẻ và đóng đúng 1 inconsistency rõ ràng
CR-EVM-008 → phụ thuộc kỹ thuật vào CR-EVM-005's cả 2 hướng (Hướng A và
             B) đã tồn tại — không chặn bởi CR nào trong nhóm 006-011,
             nhưng cần touch cả 2 hướng SSH nên effort trung bình-lớn
CR-EVM-009 → BẮT ĐẦU BẰNG QUYẾT ĐỊNH SẢN PHẨM, không phải code — nếu
             quyết định "mô hình hiện tại là v1 đúng ý", CR chỉ còn là
             sửa `docs/features/F18-ephemeral-vm.md`; nếu quyết định cần
             mount/copy-out thật, đây là CR lớn nhất trong nhóm 006-011,
             nên làm sau CR-EVM-008 (để không đụng cùng lúc SSH transport)
CR-EVM-010 → phụ thuộc vào việc xác nhận có sẵn "agent run hoàn thành"
             event source hay chưa (cùng câu hỏi CR-AUTO-005 bên nhóm
             Automations đặt ra) — khảo sát trước khi ước lượng effort
CR-EVM-011 → KHÔNG bắt đầu code trước khi có xác nhận nhu cầu sản phẩm
             thật — đây là backlog item, không phải committed work
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
  chạy song song trên cùng 1 usecase (`EphemeralVmRelay`). *(Đã Done —
  ghi chú giữ lại làm ngữ cảnh lịch sử cho CR-EVM-008, vốn touch lại
  cùng subsystem này.)*
- **CR-EVM-009 không nên bắt đầu bằng code.** Khác các CR còn lại trong
  nhóm 006-011, gap này là lệch giữa spec và implementation đã ship,
  không phải 1 tính năng rõ ràng còn thiếu — code trước khi có quyết
  định sản phẩm rủi ro xây nhầm hướng (xây mount/copy-out trong khi sản
  phẩm thực ra muốn giữ mô hình hiện tại).
- **CR-EVM-011 (container runtime) chưa có demand signal nào được xác
  nhận** — liệt vào README để không mất dấu, nhưng không nên lấy resource
  từ CR-EVM-006..010 để làm CR-EVM-011 trước khi có xác nhận từ product.
