# FE-TASK-EVM-001: Gỡ `ephemeralVm` khỏi `DESKTOP_ONLY_NAMESPACES` + audit routing

**Solution:** [FE-SOL-EVM-001](../solutions/FE-SOL-EVM-001-remove-stale-suppressor-and-routing-audit.md) | **CR:** CR-EVM-002
**Depends on:** Không
**Status:** ✅ DONE (2026-09-08)

> **Kết quả thực tế:**
> - `desktop-only-rpc-error-suppressor.ts`: gỡ `'ephemeralVm'` khỏi
>   `DESKTOP_ONLY_NAMESPACES` (hướng (b) theo FE-SOL-EVM-001 §1), thêm đoạn
>   comment "Why" theo đúng convention có sẵn của file (giống ghi chú gỡ
>   `'cli'`/`'agentTrust'` trước đó) — nêu rõ 3 method
>   `provision`/`cancelProvision`/`onProvisionEvent` vẫn chưa có route nên sẽ
>   phát sinh console error thật cho tới khi FE-SOL-EVM-002 ship (chấp nhận
>   được, có thời hạn).
> - `gitnexus`: `impact({target: "DESKTOP_ONLY_NAMESPACES", direction:
>   "downstream", repo: "orca"})` → `impactedCount: 0`, risk LOW — xác nhận
>   không logic nào khác dựa vào `ephemeralVm` có mặt trong set này ngoài
>   chính suppressor, an toàn để gỡ.
> - **Audit field-by-field (đọc trực tiếp
>   `channels_ephemeral_vm.go`/`infrafleet.proto`/`gitgateway.proto`, không
>   suy đoán) — phát hiện 3 lệch thật, KHÔNG phải bước hình thức:**
>   1. **`recipes[]` item** (`listRecipes`/`listRecipeCatalog` vs
>      `ephemeralVmRecipeView`): **khớp hoàn toàn** — `id/name/description?/
>      create/suspend?/resume?/destroy?/destroyDisabled?` đúng tên,
>      đúng optional/required cả 2 phía (so với `OrcaVmRecipe` ở
>      `frontend/src/shared/types.ts:2036`). Không cần sửa.
>   2. **`diagnostics` field (LỆCH THẬT, đã sửa)**: backend-go
>      (`read_ephemeral_vm_recipes.go`'s `parseEnvironmentRecipes`) trả
>      `diagnostics` là `[]string` đã format sẵn dạng
>      `"environmentRecipes[N]: <message>"`, trong khi
>      `window.api.ephemeralVm`'s TS type (`frontend/src/preload/
>      api-types.ts:2503-2518`) khai `diagnostics: OrcaVmRecipeDiagnostic[]`
>      — object `{index, field?, message}`. Không sửa thì
>      `useComposerState.ts`'s formatter đọc `diagnostic.index`/`.message`
>      trên 1 string → hiện `"environmentRecipes[undefined]: undefined"`,
>      nuốt mất nội dung lỗi thật (đúng loại lỗi "hiện undefined âm thầm" mà
>      solution đã cảnh báo). **Đã sửa** trong `runtime-ephemeral-vm-client.ts`:
>      hàm `normalizeEphemeralVmDiagnostics` parse tiền tố
>      `"environmentRecipes[N]: "` bằng regex để tách lại `index`/`message`
>      đúng round-trip với cách `useComposerState.ts` tái dựng label (fallback
>      dùng index mảng nếu string không có tiền tố — case "orca.yaml không
>      hợp lệ YAML"). Áp dụng cho cả 2 method
>      `listRuntimeEphemeralVmRecipes`/`listRuntimeEphemeralVmRecipeCatalog`.
>   3. **`status`/`message` wrapper field của `listRecipes` (LỆCH THẬT, đã
>      sửa nhẹ)**: TS type khai `status: 'ok'|'error'` (required) +
>      `message?`, nhưng backend-go's `ephemeralVm.listRecipes` handler
>      không bao giờ trả 2 field này (chỉ `repoPath/recipes/diagnostics`) —
>      variant desktop-only `status:'error'` (case "recipes chạy trên local
>      desktop") cấu trúc không thể xảy ra ở remote path (lỗi thật đi qua RPC
>      reject, bắt ở `.catch()`, không qua field `status`). Impact thấp
>      (`result.status === 'error'` vốn luôn `false` khi `undefined`, tình cờ
>      đúng hành vi "không có lỗi bổ sung" cho path này) nhưng vẫn là field
>      required bị thiếu thật — **đã sửa**: remote path backfill
>      `status: 'ok'` tường minh (phản ánh đúng bất biến thật của backend:
>      promise resolve ⇒ success), không phải dữ liệu bịa.
> - **Phát hiện LỆCH NGHIÊM TRỌNG, KHÔNG sửa được an toàn trong phạm vi 2
>   file của task này — báo cáo lại, không bỏ qua:**
>   `attachRuntimeEphemeralVmWorkspace`/`suspendRuntimeEphemeralVmWorkspace`/
>   `resumeRuntimeEphemeralVmWorkspace`/`cleanupRuntimeEphemeralVmWorkspace`/
>   `listRuntimeEphemeralVmRuntimes` vs `domain.EphemeralVmRuntime` proto
>   (`infrafleet.proto:207-215`) qua `toEphemeralVmRuntimeView`
>   (`channels_ephemeral_vm.go:438-444`):
>   - Backend-go's map chỉ có 8 field:
>     `id/repoId/recipeId/connectionType/status/environmentId/workspaceId/lastError`.
>   - Frontend's `EphemeralVmRuntimeRecord` (`frontend/src/shared/
>     ephemeral-vm-runtimes.ts:34-52`, **Zod schema**) đòi thêm 4 field
>     **required**: `cleanupStatus`, `createdAt`, `updatedAt`, `recipeResult`
>     — backend-go **không hề gửi 4 field này** (không phải optional bị
>     thiếu — khái niệm này không tồn tại phía backend-go: không track
>     cleanup-status riêng khỏi `status` chung, không có `createdAt`/
>     `updatedAt` timestamp, không có `recipeResult` — nested object mô tả
>     kết quả provision).
>   - 2 field trùng khái niệm nhưng lệch tên: `connectionType`(BE) vs
>     `connectionMode`(FE); `environmentId`(BE) vs `runtimeEnvironmentId`(FE).
>   - `status` lệch cả **vocabulary**, không chỉ tên: BE
>     `provisioning|active|suspended|error|destroyed` vs FE
>     `provisioning|running|suspended|suspend_failed|resume_failed|failed|
>     cleanup_pending|cleanup_failed|cleaned` — không có ánh xạ 1-1 an toàn
>     (BE `"error"` không phân biệt được là suspend/resume/cleanup thất bại,
>     BE không có state tương đương `cleanup_pending`/`cleanup_failed`).
>   - `EphemeralVmRuntimesSection.tsx` (Settings UI) đọc trực tiếp
>     `.cleanupStatus`/`.createdAt`/`.recipeResult`/`.status` (so khớp đúng
>     enum FE) để sort + hiển thị badge — với response backend-go thật, các
>     field required này sẽ luôn `undefined`, badge fallback về raw string
>     BE (`"active"`/`"error"`/`"destroyed"`, không khớp switch-case FE), sort
>     theo `createdAt` sẽ so sánh `undefined - undefined` (NaN, thứ tự không
>     xác định).
>   - **Không sửa** trong task này: đây không phải lệch tên/optionality đơn
>     giản (loại `sửa phía frontend cho khớp response thật` mà task cho
>     phép) mà là dữ liệu **thật sự không tồn tại** phía backend-go — remap
>     tên suông (`connectionType`→`connectionMode`,
>     `environmentId`→`runtimeEnvironmentId`) không giải quyết được phần lõi
>     (4 field required vẫn thiếu), còn tự bịa `cleanupStatus`/`createdAt`/
>     `updatedAt`/`recipeResult`/ánh xạ `status` sẽ tạo dữ liệu sai lệch
>     nguy hiểm hơn để undefined. Cần 1 task backend-go riêng mở rộng
>     `toEphemeralVmRuntimeView`/`EphemeralVmRuntime` proto (thêm
>     cleanup-status tracking + timestamps + recipe-result), sau đó mới sửa
>     phía frontend — ngoài phạm vi 2 file được liệt kê ở task này.
> - Test: cập nhật `desktop-only-rpc-error-suppressor.test.ts` (+1 test xác
>   nhận `ephemeralVm.*` không còn bị suppress). Viết mới
>   `runtime-ephemeral-vm-client.test.ts` (6 test: local-path routing giữ
>   nguyên cho cả 2 method + round-trip diagnostics-normalization với response
>   backend-go thật, kể cả case fallback không có tiền tố index).
> - Verify: `cd frontend && npx vitest run
>   src/renderer/src/runtime/desktop-only-rpc-error-suppressor.test.ts
>   src/renderer/src/runtime/runtime-ephemeral-vm-client.test.ts` →
>   **10/10 pass** (4 suppressor + 6 client). `npx tsc --noEmit` → 0 lỗi type
>   mới ở 3 file đã sửa/thêm (`desktop-only-rpc-error-suppressor.ts`,
>   `runtime-ephemeral-vm-client.ts`, `runtime-ephemeral-vm-client.test.ts`);
>   baseline repo có ~141 dòng lỗi type không liên quan từ trước (từ ~226 file
>   khác đang sửa dở ngoài phạm vi task này, đã xác nhận qua grep không đụng
>   tới 2 file mục tiêu).

---

## Mục tiêu

Gỡ `'ephemeralVm'` khỏi `DESKTOP_ONLY_NAMESPACES` (theo hướng (b) đã
chọn ở FE-SOL-EVM-001 §1 — chấp nhận 3 console error tạm thời cho
`provision`/... cho tới khi FE-TASK-EVM-003 ship), audit response shape
9 method đã port khớp field-by-field giữa frontend/backend-go.

## Files cần sửa

1. `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts` (MODIFY — gỡ dòng 72)
2. `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts` (MODIFY nếu audit phát hiện lệch field — xem mục "Nội dung")

## Nội dung (xem FE-SOL-EVM-001 §2-3)

```diff
 const DESKTOP_ONLY_NAMESPACES: ReadonlySet<string> = new Set([
   // ... namespace khác giữ nguyên ...
-  'ephemeralVm',
 ])
```

**Audit bắt buộc** — so khớp field JSON giữa:

| Frontend decode | Backend-go response type |
|---|---|
| `listRuntimeEphemeralVmRecipes` | `ephemeralVmRecipeView` (`channels_ephemeral_vm.go:19-28`) |
| `listRuntimeEphemeralVmRecipeCatalog` | `ephemeralVmCatalogEntry` (`channels_ephemeral_vm.go:346-`) |
| `attach`/`suspend`/`resume`/`cleanup`RuntimeEphemeralVmWorkspace | `EphemeralVmRuntime` proto message (`infrafleet.proto:207-`) |

Ghi lại bất kỳ lệch field nào tìm được (tên, optional/required,
camelCase/snake_case) và sửa phía frontend cho khớp response thật — đây
không phải bước hình thức, xem rủi ro đã ghi ở solution.

## Test cases cần cover

- Test hiện có của `desktop-only-rpc-error-suppressor.test.ts` (nếu có)
  cập nhật để xác nhận `ephemeralVm` KHÔNG còn trong set.
- Nếu audit phát hiện lệch field: 1 test round-trip mới cho method bị
  lệch (mock response backend-go thật, xác nhận frontend decode đúng).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/runtime/desktop-only-rpc-error-suppressor.test.ts src/renderer/src/runtime/runtime-ephemeral-vm-client.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "DESKTOP_ONLY_NAMESPACES", direction: "downstream"})`
— xác nhận không có logic nào khác dựa vào `ephemeralVm` có mặt trong
set này ngoài chính suppressor.

## Blocking

Không task nào khác phụ thuộc cứng task này, nhưng nên làm sớm — độc
lập hoàn toàn với 2 task còn lại.
