# CR-EVM-001 — Agent-side `vm.exec` handler cho ephemeral VM suspend/resume/cleanup

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-EVM-001 |
| **Tên** | Thêm `agent-ephemeral-vm-handler.ts` — handler thật cho `vm.exec` mà `backend-go` đã gọi |
| **Loại** | Bug Fix (capability gap đang gây lỗi runtime thật) |
| **Priority** | **P0** |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "ephemeralVm phải đảm bảo hoạt động ở frontend, backend-go và agent" |
| **Tác động HLD** | Infra-Fleet domain, Dev Server Agent RPC catalog |
| **Tác động Features** | Ephemeral VM workspace lifecycle (suspend/resume/cleanup có command thật) |

---

## Bối cảnh & Vấn đề gốc

`backend-go`'s `EphemeralVmRelay` (SOL-004/TASK-004, đã ship) đã gọi thật
tới agent cho 3 trong 4 lifecycle method:

```go
// backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go:98
uc.callAgent(ctx, devServer, "vm.exec", map[string]any{"repoPath": repoPath, "command": command, "phase": "suspend"})
// :121 — phase "resume"
// :152 — phase "destroy"
```

`callAgent` (cùng file, dòng 58-68) dịch một lỗi "method not found" thật
từ agent thành `INFRA_EPHEMERAL_VM_UNSUPPORTED` — một lỗi **permanent,
typed**, đúng ý định thiết kế khi agent build cũ chưa hỗ trợ. Nhưng khi
audit `agent/src/relay/agent-rpc-dispatch-misc.ts`'s switch-case thật
(nơi toàn bộ `cli.*`/`shell.*`/`accounts.*`/`preflight.*` được định tuyến,
dòng 24-370) và toàn bộ `agent/src/relay/`, xác nhận: **không có
`case 'vm.exec'` nào, không có file `agent-ephemeral-vm-handler.ts`
nào** — chỉ có `agent/src/shared/ephemeral-vm-recipe-*.ts` (logic recipe
dùng cho desktop-local exec, chưa từng được wire vào agent's RPC
dispatch).

**Hệ quả thật, không phải lý thuyết**: bất kỳ recipe nào có field
`suspend`/`resume`/`destroy` không rỗng, một khi được `attachWorkspace`
vào 1 dev server thật (`connection_type: "orca-server"` — path đã "ship
đầy đủ" theo chính [BACKLOG-001](../../../../specs/backlog/BACKLOG-001-ephemeralvm-ssh-outbound-client.md)),
**luôn nhận `INFRA_EPHEMERAL_VM_UNSUPPORTED` mỗi lần suspend/resume/
cleanup có command** — không phải "tính năng chưa có", mà là lỗi runtime
đang chờ xảy ra ngay khi ai đó dùng feature này với recipe thật.

## Giải pháp đề xuất

### Thêm `agent/src/relay/agent-ephemeral-vm-handler.ts`, theo đúng khuôn mẫu `agent-cli-handler.ts`

Mỗi handler `cli.*` (`agent-rpc-dispatch-misc.ts:162-232`) đều theo pattern
lazy-import + hàm xử lý riêng trong 1 file module theo domain. `vm.exec`
theo đúng khuôn đó:

```ts
// agent/src/relay/agent-ephemeral-vm-handler.ts
import { runRecipeCommand } from '../shared/ephemeral-vm-recipe-process'

export async function handleVmExec(params: {
  repoPath: string
  command: string
  phase: 'suspend' | 'resume' | 'destroy'
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await runRecipeCommand({
    command: params.command,
    repoPath: params.repoPath,
    mode: params.phase,
    context: { /* recipe id/instance id — xem "Rủi ro" */ }
  })
  if (result.exitCode !== 0) {
    throw new Error(`vm.exec (${params.phase}) exited ${result.exitCode}: ${result.stderr.slice(-2000)}`)
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}
```

Không viết lại logic spawn/kill/env — `runRecipeCommand`
(`agent/src/shared/ephemeral-vm-recipe-process.ts:23-`) đã có sẵn, đã có
test (`ephemeral-vm-recipe-process.test.ts`), đã hỗ trợ đúng 3 mode
`suspend`/`resume`/`destroy` cần ở đây (`create` dành riêng cho
CR-EVM-003's `provision`, không dùng ở CR này).

### Wire vào `agent-rpc-dispatch-misc.ts`

Thêm 1 `case 'vm.exec':` theo đúng vị trí/khuôn `case 'cli.install'`
(dòng 176-186) — lazy `await import('./agent-ephemeral-vm-handler')`,
validate `params` bằng cùng convention `requiredString`/zod đã dùng ở
`agent-rpc-dispatch-browser.ts`/`agent-rpc-dispatch-misc.ts`.

### Trả lỗi đúng "method not found" khi agent build cũ

Không cần code gì thêm cho phần này — cơ chế `domain.ErrAgentMethodNotFound`
ở `backend-go` đã tự động phân loại đúng khi agent thật sự chưa có case
này (agent build cũ, chưa deploy CR này) — `callAgent`
(`ephemeral_vm_relay.go:61-64`) đã dịch nó thành
`INFRA_EPHEMERAL_VM_UNSUPPORTED` sẵn, đúng ý nghĩa thật của lỗi đó sau CR
này (trước CR này, lỗi đó bị trả ra ngay cả khi agent mới nhất — nhầm
lẫn giữa "agent cũ" và "agent chưa từng hỗ trợ").

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `EphemeralVmRecipeContext` (`recipeId`/`instanceId`/... — dùng để build env `ORCA_VM_*`) chưa có tại điểm gọi `vm.exec` | Trung bình | `SuspendWorkspace`/`ResumeWorkspace`/`CleanupWorkspace`'s `map[string]any` params hiện chỉ gửi `repoPath`/`command`/`phase` — cần bổ sung `recipeId`/`runtimeId` vào params gửi từ `backend-go` (đổi cả `EphemeralVmRelay` lẫn wscompat caller) để agent build đúng `ORCA_VM_*` env, nếu recipe command phụ thuộc các biến đó |
| Recipe chạy shell command tuỳ ý trên Dev Server, kế thừa credentials của máy đó | Đã biết, không tăng thêm | Đúng class rủi ro `EphemeralVmRelay`'s doc comment đã nêu (giống `EmulatorRelay`) — CR này chỉ hiện thực hoá đúng behavior đã thiết kế, không mở rộng blast radius |
| Backward-compat với agent build cũ (rollout dần) | Thấp | Đã xử lý tự nhiên qua `ErrAgentMethodNotFound` — không cần feature-flag phía backend-go |

## Không thuộc phạm vi CR này

- `vm.provision` (mode `create`, streaming stdout/stderr) — xem
  [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md); CR này chỉ xử lý
  3 mode one-shot đã có call site thật.
- `connection_type == "ssh"` — vẫn trả lỗi permanent, không đổi bởi CR
  này (xem [CR-EVM-005](./CR-EVM-005-ssh-connection-type-outbound-client.md)).

## Liên quan

- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go:80-158`
- `agent/src/relay/agent-rpc-dispatch-misc.ts:162-232` (khuôn mẫu `cli.*`)
- `agent/src/shared/ephemeral-vm-recipe-process.ts` (`runRecipeCommand`, tái dùng nguyên xi)
- `specs/backend-go/bugs/missing-v3/tasks/TASK-004-ephemeral-vm-lifecycle-relay-usecase.md` (nguồn gốc `EphemeralVmRelay`)
- [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) (dùng chung `agent-ephemeral-vm-handler.ts`)
