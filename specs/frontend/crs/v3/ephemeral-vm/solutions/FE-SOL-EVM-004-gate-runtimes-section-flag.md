# FE-SOL-EVM-004: Gate `<EphemeralVmRuntimesSection />` sau `experimentalEphemeralVms`

> **🔲 Designed — chưa implement.** 1-dòng-scale fix, khớp pattern đã có.

**CR:** [CR-EVM-007](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-007-gate-runtimes-section-experimental-flag.md)
**TDD tham chiếu:** [TDD-FE-03](../../../../tdd/v5/03-runtime-client-layer.md) §2

---

## 1. Trạng thái hiện tại (xác nhận chính xác)

`RuntimeEnvironmentsPane.tsx` mount `<EphemeralVmRuntimesSection />`
không điều kiện (giữa 2 block khác, không có wrapper flag check).
`EphemeralVmsExperimentalSetting.tsx:53` là pattern đúng cần theo:
`{enabled ? <EphemeralVmsPane /> : null}` với `enabled =
settings.experimentalEphemeralVms === true`.

## 2. Giải pháp

`RuntimeEnvironmentsPane.tsx` cần `settings` (`GlobalSettings`) trong
scope tại điểm mount — xác nhận component này đã nhận `settings` qua
props hay cần đọc từ store (`useAppStore`) trước khi code, theo đúng
cách phần còn lại của cùng component đọc settings (không tạo cách đọc
mới).

```tsx
// RuntimeEnvironmentsPane.tsx, thay:
<EphemeralVmRuntimesSection />
// bằng:
{settings.experimentalEphemeralVms === true && <EphemeralVmRuntimesSection />}
```

Thêm comment cảnh báo giống `sleep-worktree-flow.ts:150-157`/
`sidebar-worktree-activation.ts:18-27` ngay tại điểm mount:

```tsx
// Why: window.api.ephemeralVm is truthy even when the backend doesn't
// actually serve it (web/paired preload's fallback Proxy) — must gate on
// the Settings flag, not RPC availability. See CR-EVM-007.
```

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Không dependency | Thấp | |
| User có runtime cũ có thể không thấy trong Settings sau khi tắt cờ | Thấp | Chấp nhận được, nhất quán với `EphemeralVmsPane` |

## Không thuộc phạm vi solution này

- Audit các entry point khác — đã xác nhận đúng (chỉ 1 điểm lệch).

## Liên quan

- `frontend/src/renderer/src/components/settings/EphemeralVmRuntimesSection.tsx:57-82`
- `frontend/src/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx` (điểm mount `<EphemeralVmRuntimesSection />`)
- `frontend/src/renderer/src/components/settings/EphemeralVmsExperimentalSetting.tsx:19,50,53`
- `frontend/src/renderer/src/lib/sleep-worktree-flow.ts:150-158`
