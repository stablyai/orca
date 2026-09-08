# FE-TASK-STORAGE-013: Hydrate `bootstrap.ts`/`ssh.ts`/`provisioning.ts`/`runtime-environment-ssh.ts`

**Solution:** FE-SOL-STORAGE-006 | **CR:** CR-STORAGE-006
**Depends on:** [TASK-BE-STORAGE-005](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-005-audit-infra-fleet-read-handlers.md) (backend-go)
**Status:** 🟡 PARTIAL — ssh/provisioning/runtime-environment-ssh ✅ DONE, bootstrap.ts 🔲 BLOCKED (DevServer proto has no bootstrap_status field, confirmed via BE-SOL-STORAGE-002's audit — needs a backend-go proto field addition, out of scope here)

> **Implementation notes (2026-09-07):**
> - `ssh.ts`: added `hydrateSshTargets()` action — calls `listRuntimeSshTargets`/`listRuntimeSshRemovedTargetLabels`/`getRuntimeSshState` (the existing `runtime/runtime-ssh-client.ts` wrappers around `ssh.listTargets`/`ssh.listRemovedTargetLabels`/`ssh.getState`) and sets `sshTargets`/`sshTargetLabels`/`sshTargetsHydrated`/`removedSshTargetLabels`/`sshConnectionStates`. **Note:** an equivalent inline hydrate already runs today in `App.tsx` (~L1032, L1099) and `useIpcEvents.ts` (~L2760-2790) at startup — those are untouched (out of scope) and keep running; this action is an additive, unit-tested entry point matching CR-STORAGE-006's target pattern, not yet wired to replace the inline call sites (a follow-up consolidation task, if desired, is out of scope here).
> - `runtime-environment-ssh.ts`: added `hydrateEnvironmentSshState(environmentId)` action, same pattern, scoped to one remote environment via `callRuntimeRpc({kind:'environment', environmentId}, ...)`. **Note:** `runtime/runtime-environment-ssh-state.ts`'s `hydrateRuntimeEnvironmentSshState` already implements and is already wired to this exact same read path (`TerminalPane.tsx` mount, `useIpcEvents.ts` reachability transitions), with its own passing test coverage in `runtime-environment-ssh-state.test.ts`. The new slice action does not replace it — it gives the slice itself a testable, self-contained hydrate entry point per the task's literal file scope.
> - `provisioning.ts`: **left unmodified.** Its current shape (`provisioningSession`: an ephemeral, dialog-scoped bulk-relay-deploy wizard state) has no backing read RPC to hydrate from — confirmed no `provisioning.*` wscompat channel exists in `backend-go/services/api-gateway/internal/adapter/wscompat/`. Progress is driven entirely by a desktop-only `window.api.ssh.provisionFleetServers` IPC call plus push events (`provisioning-events.ts`'s `ProvisioningProgressEvent`), and `FleetProvisionWizard.tsx` resets to step `'select'` on every dialog open — there is no "resume an in-progress session on app mount" concept in the design to hydrate. Per the task's own escape hatch ("add hydrate action, if applicable per its actual current shape"), no action was added and no RPC was invented.
> - `bootstrap.ts`: **untouched**, per the task's own instruction — `bootstrap_status` does not exist on the `DevServer` proto message (confirmed via BE-SOL-STORAGE-002's audit appendix), so `resumeBootstrapProgressIfAny` cannot be implemented against a real field today.
> - Verify: `cd frontend && npx vitest run src/renderer/src/store/slices/ssh.test.ts src/renderer/src/store/slices/runtime-environment-ssh.test.ts` → **22 tests passed** (2 test files). `provisioning.test.ts` does not exist and was not created (no hydrate action was added). `bootstrap.test.ts` untouched.

---

## Mục tiêu

Cùng pattern hydrate như FE-TASK-STORAGE-012, áp dụng cho 4 slice còn lại
trong nhóm CR-STORAGE-006 — đọc lại từ RPC đã có khi mount, không đổi cơ
chế cập nhật live.

## Files cần sửa

1. `frontend/src/renderer/src/store/slices/bootstrap.ts` (MODIFY)
2. `frontend/src/renderer/src/store/slices/ssh.ts` (MODIFY)
3. `frontend/src/renderer/src/store/slices/provisioning.ts` (MODIFY)
4. `frontend/src/renderer/src/store/slices/runtime-environment-ssh.ts` (MODIFY)
5. Test file tương ứng cho cả 4

## Nội dung (xem FE-SOL-STORAGE-006 §3-§4)

```ts
// bootstrap.ts
async function resumeBootstrapProgressIfAny(devServerId: string, target: RuntimeTarget) {
  const devServer = await callRuntimeRpc(target, 'devServer.get', { id: devServerId })
  if (devServer.bootstrapStatus && devServer.bootstrapStatus !== 'idle') {
    set({ bootstrapStage: devServer.bootstrapStatus })
  }
}
```

`ssh.ts`/`provisioning.ts`/`runtime-environment-ssh.ts` — cùng khuôn: gọi
RPC đọc tương ứng (`ListSshTargets`/`GetSshState` — xác nhận namespace
theo kết quả TASK-BE-STORAGE-005) khi mount, `set()` vào reducer.

## ⚠️ Phụ thuộc kết quả audit

Nếu TASK-BE-STORAGE-005 phát hiện `bootstrap_status` field KHÔNG có mặt
trong `DevServer`/`GetDevServer` response, task này **không** thể hoàn
thành phần `bootstrap.ts` cho tới khi backend-go bổ sung field đó — báo
cáo lại thay vì tự thêm RPC mới ngoài phạm vi đã thiết kế.

## Test cases cần cover

- `resumeBootstrapProgressIfAny`: set đúng `bootstrapStage` khi
  `bootstrapStatus !== 'idle'`, KHÔNG set gì khi `'idle'` (giữ nguyên UI
  mặc định, không nhảy vào 1 bước "idle" không tồn tại trong flow).
- `ssh.ts`/`provisioning.ts`/`runtime-environment-ssh.ts`: mỗi slice có ít
  nhất 1 test hydrate-thành-công + 1 test hydrate-lỗi-không-crash.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/store/slices/bootstrap.test.ts src/renderer/src/store/slices/ssh.test.ts src/renderer/src/store/slices/provisioning.test.ts src/renderer/src/store/slices/runtime-environment-ssh.test.ts
```

## gitnexus

`impact()` riêng cho từng slice trước khi sửa (4 lần gọi, mỗi slice 1 lần)
— theo đúng yêu cầu bắt buộc, không gộp chung vì đây là 4 symbol độc lập.

## Blocking

Không.
