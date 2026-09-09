# FE-AUTO-SOL-001: Xác nhận routing 2-trục đã đúng, không cần migration

> **🔲 Designed — chưa implement.** Chủ yếu xác nhận + 1 cải thiện nhỏ về
> khả năng quan sát (observability), không phải thiết kế mới.

**CR:** [CR-AUTO-001](../../../../../../docs/crs/v4/automations/CR-AUTO-001-consolidate-execution-backend.md)
**backend-go counterpart:** [BE-AUTO-SOL-001](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-001-confirm-routing-close-gaps.md)
**TDD tham chiếu:** [TDD-FE-03](../../../../tdd/v5/03-runtime-client-layer.md) §2

---

## 1. Trạng thái hiện tại (renderer)

`automation-host-client.ts` đã route đúng: `{kind: 'local'}` →
`window.api.automations.*` (Electron/Node tuỳ deployment), `{kind:
'environment', environmentId}` → `callRuntimeRpc` → backend-go. Không
lỗi kiến trúc — chỉ thiếu 1 điểm quan sát: user không biết automation
họ đang xem/tạo đang chạy trên backend nào (Electron-local hay
backend-go), dễ gây nhầm lẫn khi debug ("sao automation tôi tạo lúc pair
runtime environment biến mất khi unpair" — đúng hành vi thiết kế, nhưng
không hiển thị rõ).

## 2. Giải pháp

### Hiển thị rõ "automation này chạy ở đâu" trong UI

`AutomationDetail.tsx`/`AutomationsPage.tsx`'s list row: thêm 1 badge
nhỏ ("Local" / tên runtime environment) dựa vào
`getAutomationOwnerTarget(automation, sourceTarget)` đã có sẵn (không
tính toán lại target theo cách khác) — tái dùng hàm đã export từ
`automation-host-client.ts`.

### Không đổi routing logic

Xác nhận (đọc lại `getAutomationCreateTarget`/`getAutomationOwnerTarget`)
rằng automation "thuộc về" đúng target nơi nó được tạo (qua
`runContext.hostId`), không đổi theo `activeRuntimeEnvironmentId` hiện
tại của session — nghĩa là 1 automation tạo lúc pair environment A vẫn
"thuộc" A dù user sau đó pair sang B hoặc unpair. Xác nhận hành vi này
khớp mong đợi (đọc `getAutomationTargetFromHostId`/`parseExecutionHostId`
kỹ trước khi khẳng định) — nếu đúng, không cần code, chỉ cần ghi vào UI
(mục trên) cho rõ ràng với user.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Badge mới cần tra cứu tên runtime environment (không chỉ id) | Thấp | Kiểm tra store/slice đã có danh sách runtime environment với tên hiển thị chưa, tái dùng thay vì fetch riêng |

## Không thuộc phạm vi solution này

- Bất kỳ thay đổi routing logic nào — không cần, đã đúng.

## Liên quan

- `frontend/src/renderer/src/components/automations/automation-host-client.ts:44-52` (`getAutomationOwnerTarget`)
- `frontend/src/renderer/src/components/automations/AutomationDetail.tsx`
- [BE-AUTO-SOL-001](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-001-confirm-routing-close-gaps.md)
