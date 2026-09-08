# FE-TASK-EVM-003: `runtime-ephemeral-vm-client.ts` — route `provision`/`cancelProvision`

**Solution:** [FE-SOL-EVM-002](../solutions/FE-SOL-EVM-002-provision-streaming-client.md) §3 | **CR:** CR-EVM-003
**Depends on:** [FE-TASK-EVM-002](./FE-TASK-EVM-002-subscribe-runtime-stream-channel-client.md) (DONE)
**Status:** ✅ DONE

---

## Kết quả thực tế

**Đã xong:**

- Audit bắt buộc trước khi code xác nhận chữ ký THẬT khác đáng kể so với
  sketch gốc của task này:
  - `window.api.ephemeralVm.provision` thật (`frontend/src/preload/api-types.ts:2520-2545`)
    nhận `{repoId, recipeId, workspaceName?, projectId?, workspaceId?,
    provisionId?}` và **resolve với KẾT QUẢ CUỐI CÙNG đầy đủ**
    (`{ok:true, connectionType:'orca-server'|'ssh', runtime, ...}` |
    `{ok:false, error, stderr, stdout}`) — không phải mô hình
    "ack ngay rồi stream" như sketch giả định. Streaming thật là broadcast
    IPC toàn cục `onProvisionEvent` (không scope theo 1 lời gọi, phải tự
    filter theo `provisionId`), đã xác nhận qua 2 call site thật
    (`frontend/src/renderer/src/lib/ephemeral-vm-workspace-target.ts`,
    `frontend/src/renderer/src/lib/ephemeral-vm-worktree-creation.ts`).
  - `window.api.ephemeralVm.cancelProvision` nhận `{provisionId: string}`
    (object), không phải positional string như code mẫu trong sketch —
    đã sửa khi implement.
  - `subscribeRuntimeStreamChannel<TAck,TEvent>(target, method, params,
    onEvent): Promise<{ack, unsubscribe}>` thật (FE-TASK-EVM-002) khớp
    generic signature trong solution, chỉ khác: `target.kind === 'local'`
    reject rõ ràng thay vì được gọi cho desktop.
  - Đọc `BE-SOL-EVM-002` §4/§6 + `TASK-BE-EVM-005` (backend-go, chưa
    implement nhưng đã DESIGNED chi tiết) xác nhận wire contract dự kiến
    cho nhánh environment: args `{connectionId, recipeId, runtimeId}`
    (KHÁC args của `window.api.ephemeralVm.provision` — 2 flow khác nhau
    thật sự, không phải lệch tên: desktop provision "from-repo", còn
    channel backend-go provision cho 1 connection/runtime đã resolve sẵn),
    ack `{provisionId}`, push event `{type: 'stdout'|'stderr'|'result'|
    'error', chunk?, result?}` (`VmProvisionResult` proto). `cancelProvision`
    args `{provisionId}` khớp đúng sketch.
- Implemented `provisionRuntimeEphemeralVmWorkspace`/
  `cancelRuntimeEphemeralVmProvision` trong
  `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts`,
  theo khuôn 9 hàm cũ (tham số đầu là `settings`, gọi
  `getActiveRuntimeTarget(settings)` nội bộ — KHÔNG nhận `target` trực
  tiếp như sketch, để nhất quán với 9 hàm hiện có, đúng chỉ dẫn "theo
  đúng khuôn 9 hàm đã có").
  - `provisionRuntimeEphemeralVmWorkspace(settings, args, onEvent):
    Promise<{ack:{provisionId}, unsubscribe}>` — nhánh `local` dùng
    `subscribeDesktopProvisionBroadcast` (hàm mới, adapter mỏng bọc
    `window.api.ephemeralVm.provision` + `onProvisionEvent` filter theo
    `provisionId`, generate `provisionId` qua `crypto.randomUUID()` nếu
    caller không truyền — KHÔNG đổi lời gọi/hành vi IPC thật); nhánh
    `environment` gọi `subscribeRuntimeStreamChannel(target,
    'ephemeralVm.provision', {connectionId, recipeId, runtimeId}, onEvent)`.
    Cả 2 nhánh đồng nhất hoá qua 1 `onEvent` contract chung
    (`EphemeralVmProvisionStreamEvent`, mirror `VmProvisionEvent`'s
    `stdout`/`stderr`/`result`/`error` shape) — nhánh desktop tự tổng hợp
    event `result`/`error` từ giá trị resolve/reject thật của
    `provision()`, rồi tự `unsubscribe()` broadcast listener.
  - `cancelRuntimeEphemeralVmProvision(settings, provisionId):
    Promise<{cancelled}>` — local gọi
    `window.api.ephemeralVm.cancelProvision({provisionId})` (object, đã
    sửa so với sketch), environment gọi `callRuntimeRpc(target,
    'ephemeralVm.cancelProvision', {provisionId})`.
- Test đầy đủ tại `runtime-ephemeral-vm-client.test.ts` (14 test mới +
  giữ nguyên các test cũ của 9 hàm, không regress): mock cho cả local
  (window.api.ephemeralVm.provision/cancelProvision/onProvisionEvent) và
  environment (`subscribeRuntimeStreamChannel`/`callRuntimeRpc` mocked)
  — cover: provision local forward đúng args + filter broadcast theo
  provisionId + emit `result`/`error` + auto-unsubscribe; generate
  provisionId khi thiếu; reject rõ ràng khi thiếu `repoId` (local) hoặc
  `connectionId`/`runtimeId` (environment); `unsubscribe()` chặn event
  tiếp theo; `cancelRuntimeEphemeralVmProvision` route đúng theo
  `target.kind`.
- Verify thật:
  - `npx vitest run src/renderer/src/runtime/runtime-ephemeral-vm-client.test.ts`
    → **14 passed, 1 todo**.
  - `npx vitest run src/renderer/src/runtime/runtime-rpc-client.test.ts`
    → 28 passed, 1 todo (không regress từ FE-TASK-EVM-002).
  - `npx tsc --noEmit` → diff trước/sau chỉ loại bỏ lỗi tự gây ra khi
    soạn test (đã sửa), **0 lỗi mới** trong 2 file đã sửa
    (`runtime-ephemeral-vm-client.ts`, `runtime-ephemeral-vm-client.test.ts`);
    toàn bộ lỗi còn lại là pre-existing, không liên quan (thuộc ~226 file
    đang sửa dở khác trong working tree).
  - `npx vitest run src/renderer/src/runtime/` → 46/47 file pass; 1 file
    fail (`runtime-cli-client.test.ts`, 3 test) — xác nhận **pre-existing**,
    không liên quan (file này KHÔNG nằm trong diff của task này,
    `git status --porcelain` rỗng cho cả `.ts` và `.test.ts`).

**Cập nhật (TASK-BE-EVM-005 đã ship — integration test hoàn tất, event shape đã verify):**

- Event shape: đọc trực tiếp `channels_ephemeral_vm.go`'s
  `toEphemeralVmProvisionResultView` xác nhận payload THẬT của
  `result.result` khớp CHÍNH XÁC với `EphemeralVmChannelProvisionOutcome`
  đã viết trong `runtime-ephemeral-vm-client.ts` — `{type: 'orca-server'|
  'ssh', projectRoot, pairingCode?, sshTarget?}` — không cần sửa gì ở
  file production (chỉ 2 file test được phép sửa theo phạm vi task này).
  Push event bao ngoài còn có thêm field `provisionId` (không nằm trong
  type `EphemeralVmProvisionStreamEvent` khai báo, nhưng có mặt thật ở
  runtime — không ảnh hưởng vì `subscribeRuntimeStreamChannel` chỉ cast,
  không validate).
- Audit tiền lệ integration test (bắt buộc, xem chi tiết đầy đủ ở
  FE-TASK-EVM-002's "Kết quả thực tế"): frontend test suite không có tiền
  lệ nào kết nối tới backend-go THẬT — mock-only kể cả các case chặt chẽ
  nhất. Không có hạ tầng harness nào để tái dùng.
- Bỏ `it.todo`, viết test integration-flavored thật ở mức sâu nhất khả
  thi: test mới (`describe('provisionRuntimeEphemeralVmWorkspace')`'s
  cuối cùng) gỡ mock `subscribeRuntimeStreamChannel` về implementation
  THẬT (qua `vi.importActual`) cho đúng 1 test này, rồi mock ở tầng thấp
  hơn — `window.api.runtimeEnvironments.subscribe` — bằng đúng wire shape
  THẬT (ack `{provisionId}`, push event
  `{provisionId, type, chunk|result}` theo `pipePushForDialect`/
  `pushEventResult`, xác nhận qua source THẬT, xem FE-TASK-EVM-002). Test
  này verify toàn bộ chuỗi thật:
  `provisionRuntimeEphemeralVmWorkspace` → `subscribeRuntimeStreamChannel`
  (THẬT, không mock) → `window.api.runtimeEnvironments.subscribe` →
  `onEvent`, đây là chuỗi frontend đầy đủ nhất có thể test được không cần
  1 backend-go process thật.
- Verify thật:
  - `npx vitest run src/renderer/src/runtime/runtime-ephemeral-vm-client.test.ts`
    → **15 passed, 0 todo**.
  - `npx vitest run src/renderer/src/runtime/runtime-rpc-client.test.ts`
    → 29 passed, 0 todo (không regress từ FE-TASK-EVM-002).
  - `npx tsc --noEmit` → 0 lỗi mới trong 2 file test đã sửa (baseline
    trước/sau: 146 → 142 lỗi — đúng số lỗi tạm thời tự gây ra rồi tự sửa
    hết khi soạn test `subscription.callbacks` typing, không còn sót).
  - `npx vitest run src/renderer/src/runtime/` → 46/47 file pass; 1 file
    fail (`runtime-cli-client.test.ts`, 3 test) — **xác nhận lại vẫn
    pre-existing, không liên quan** (`git status --porcelain` rỗng cho cả
    `.ts` và `.test.ts` của file này).
- **Còn thiếu thật sự** (ghi nhận rõ, không lấp được trong phạm vi task
  này): như FE-TASK-EVM-002, đây không phải 1 test cross-process thật
  (không có backend-go binary/gRPC server chạy) — repo chưa có hạ tầng
  cho việc đó trong `frontend/` package; cross-process thật (nếu cần) sẽ
  thuộc Playwright e2e (`tests/e2e/`), ngoài phạm vi 2 task frontend này.

---

## Mục tiêu

Thêm `provisionRuntimeEphemeralVmWorkspace`/`cancelRuntimeEphemeralVmProvision`
vào `runtime-ephemeral-vm-client.ts`, dùng `subscribeRuntimeStreamChannel`
(FE-TASK-EVM-002) cho web/paired, giữ nguyên `window.api.ephemeralVm.*`
cho desktop.

## Files cần sửa

1. `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts` (MODIFY — 2 hàm mới, theo đúng khuôn 9 hàm đã có)
2. Test file tương ứng

## Nội dung (xem FE-SOL-EVM-002 §3)

```ts
export function provisionRuntimeEphemeralVmWorkspace(
  target: RuntimeClientTarget,
  args: { recipeId: string; runtimeId: string; connectionId: string },
  onEvent: (event: EphemeralVmProvisionEvent) => void
): Promise<{ ack: { provisionId: string }; unsubscribe: () => void }> {
  if (target.kind === 'local') {
    return subscribeDesktopProvisionBroadcast(args, onEvent)   // window.api, giữ nguyên hành vi cũ
  }
  return subscribeRuntimeStreamChannel(target, 'ephemeralVm.provision', args, onEvent)
}

export function cancelRuntimeEphemeralVmProvision(
  target: RuntimeClientTarget, provisionId: string
): Promise<{ cancelled: boolean }> {
  if (target.kind === 'local') {
    return window.api.ephemeralVm.cancelProvision(provisionId)
  }
  return callRuntimeRpc(target, 'ephemeralVm.cancelProvision', { provisionId })
}
```

`subscribeDesktopProvisionBroadcast` — helper mới bọc quanh
`window.api.ephemeralVm.provision` + lắng nghe broadcast IPC event
`ephemeralVm:provisionEvent` hiện có, chuẩn hoá về cùng shape
`onEvent(event)` như nhánh web — **không đổi cơ chế desktop**, chỉ thêm
1 lớp adapter mỏng để 2 nhánh có cùng interface gọi từ UI.

## Test cases cần cover

- `target.kind === 'local'` → gọi đúng `window.api.ephemeralVm.provision`, `onEvent` nhận đúng event từ broadcast (mock `window.api`).
- `target.kind === 'environment'` → gọi đúng `subscribeRuntimeStreamChannel(target, 'ephemeralVm.provision', ...)`.
- `cancelRuntimeEphemeralVmProvision` route đúng theo `target.kind` (local vs environment).
- Không regress 9 hàm hiện có trong cùng file (test suite hiện có tiếp tục pass).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/runtime/runtime-ephemeral-vm-client.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "runtime-ephemeral-vm-client", direction: "downstream"})`
— xác nhận các call site hiện có (`ephemeral-vm-worktree-creation.ts`)
không bị ảnh hưởng bởi 2 hàm mới thêm vào cùng file.

## Blocking

Không task nào khác phụ thuộc task này — đây là task cuối của nhóm CR
ephemeral-vm ở phía frontend cho tới khi có UI cụ thể muốn dùng
`provision` (ngoài phạm vi, xem FE-SOL-EVM-002 §4).
