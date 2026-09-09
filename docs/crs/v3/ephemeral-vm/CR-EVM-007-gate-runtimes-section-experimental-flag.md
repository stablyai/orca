# CR-EVM-007 — Gate `EphemeralVmRuntimesSection` sau cờ `experimentalEphemeralVms`

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-EVM-007 |
| **Tên** | Sửa 1 điểm gate flag bị bỏ sót — `EphemeralVmRuntimesSection` gọi RPC không điều kiện |
| **Loại** | Bug Fix |
| **Priority** | P2 (nhỏ, nhưng nhất quán với mọi entry point khác nên ưu tiên làm sớm) |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn sau khi xác nhận CR-EVM-001..005 đã Done |
| **Tác động HLD** | Frontend Settings surface |
| **Tác động Features** | F18 (Ephemeral VM) — gating nhất quán cho tính năng experimental |

---

## Bối cảnh & Vấn đề gốc

`settings.experimentalEphemeralVms`
(`frontend/src/shared/types.ts:3008`, default `false`,
`frontend/src/shared/constants.ts:375`) là cờ gate cho toàn bộ tính năng
ephemeral VM. Mọi entry point UI khác đều check cờ này đúng cách:

- `EphemeralVmsExperimentalSetting.tsx:19,50` — chính toggle, gate luôn
  `EphemeralVmsPane` (dòng 53).
- `sleep-worktree-flow.ts:150-158` — có comment cảnh báo tường minh: phải
  check **cờ Settings**, không chỉ `window.api?.ephemeralVm` truthy, vì
  preload's fallback Proxy (web/paired mode) làm namespace đó **luôn
  truthy** dù backend không thật sự serve.
- `sidebar-worktree-activation.ts:18-28` — cùng cảnh báo, cùng pattern
  check đúng.
- `useComposerState.ts:862` — check đúng.

**Ngoại lệ duy nhất**: `EphemeralVmRuntimesSection.tsx`, mount không điều
kiện tại `RuntimeEnvironmentsPane.tsx:998`
(`<EphemeralVmRuntimesSection />`, không có flag check bao quanh) — gọi
`window.api.ephemeralVm.listRuntimes()` ngay khi mount
(`EphemeralVmRuntimesSection.tsx:57-82`), **bất kể**
`experimentalEphemeralVms`. Người dùng chưa bật cờ experimental vẫn kích
hoạt RPC này mỗi lần mở Settings → Runtime Environments.

## Giải pháp đề xuất

Thêm flag check bao quanh `<EphemeralVmRuntimesSection />` tại
`RuntimeEnvironmentsPane.tsx:998`, theo đúng pattern đã dùng ở
`EphemeralVmsExperimentalSetting.tsx:53`:

```tsx
{settings.experimentalEphemeralVms && <EphemeralVmRuntimesSection />}
```

Đồng thời, để không lặp lại cùng loại bug trong tương lai, thêm comment
cảnh báo giống `sleep-worktree-flow.ts:150-157`/
`sidebar-worktree-activation.ts:18-27` ngay tại điểm mount, ghi rõ lý do
(`window.api.ephemeralVm` luôn truthy qua preload fallback Proxy ở
web/paired mode — không đủ để suy luận backend thật sự serve).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Không có dependency, 1 điểm sửa | Thấp | Đúng nghĩa 1-dòng-scale fix, giống CR-EVM-002 gốc |
| User đã có runtime tồn tại từ trước khi tắt cờ có thể không thấy chúng nữa trong Settings | Thấp | Chấp nhận được — nhất quán với cách `EphemeralVmsPane` đã ẩn hoàn toàn sau cờ; nếu cần "vẫn cho xem runtime cũ dù tắt cờ", đó là quyết định sản phẩm riêng ngoài scope CR này |

## Không thuộc phạm vi CR này

- Audit lại toàn bộ các entry point khác — đã audit xong (2026-09-09),
  chỉ 1 điểm này lệch.

## Liên quan

- `frontend/src/renderer/src/components/settings/EphemeralVmRuntimesSection.tsx:57-82`
- `frontend/src/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx:998`
- `frontend/src/renderer/src/components/settings/EphemeralVmsExperimentalSetting.tsx:19,50,53` (pattern tham chiếu)
- `frontend/src/renderer/src/lib/sleep-worktree-flow.ts:150-158` (cảnh báo tường minh, tham chiếu)
- `frontend/src/renderer/src/lib/sidebar-worktree-activation.ts:18-28` (cảnh báo tường minh, tham chiếu)
- `frontend/src/shared/types.ts:3008`, `frontend/src/shared/constants.ts:375`
