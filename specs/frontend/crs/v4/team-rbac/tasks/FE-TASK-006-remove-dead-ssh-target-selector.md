# FE-TASK-006: Xoá `selectSshTargetsForCurrentUser` (dead selector, 0 caller)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) Phần A
**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Priority:** 🔴 P0
**Estimated:** 15 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

`selectSshTargetsForCurrentUser` (`store/selectors.ts:265-281`) là 1 trong 2 cơ chế "server
visibility theo project" đã xác nhận **chết hoàn toàn** — `impact()` xác nhận impactedCount = 0
(0 caller trong toàn repo). Xoá an toàn, không có gì khác cần sửa theo.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/store/selectors.ts` | MODIFY — xoá hàm `selectSshTargetsForCurrentUser` (dòng 265-281) |

## Các bước thực thi

1. Mở `frontend/src/renderer/src/store/selectors.ts`.
2. Xoá toàn bộ hàm `selectSshTargetsForCurrentUser` (dòng 265-281 theo audit — xác nhận lại số
   dòng thật khi mở file, có thể lệch nếu file đã đổi từ lúc viết solution).
3. Xoá import chỉ dùng riêng cho hàm này nếu có (kiểm tra sau khi xoá, để `tsc`/lint tự báo unused
   import).

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -rn "selectSshTargetsForCurrentUser" frontend/src
```

Grep phải trả về rỗng sau khi xoá (không còn định nghĩa lẫn caller).

## Depends on

Không có.

## Blocking

Không có.

## Kết quả thực tế (2026-09-09)

`impact({target: "selectSshTargetsForCurrentUser", direction: "upstream"})` xác nhận đúng
`impactedCount = 0, risk: "LOW"` (0 caller trong toàn repo) — khớp audit gốc. Đã xoá toàn bộ hàm
(kèm header comment `// ── RBAC Filtering Selector (CR-006) ──` và doc comment ngay phía trên, vì
cả 2 chỉ mô tả riêng hàm này) tại `frontend/src/renderer/src/store/selectors.ts` — hàm nằm ở cuối
file (dòng 265-281 kể cả comment mở rộng đến 256), khớp số dòng ghi trong task. Kiểm tra
`AppState`/`SshTarget` (2 import dùng trong hàm đã xoá) vẫn còn được dùng ở nơi khác trong cùng file
— không có import nào trở thành unused.

`grep -rn "selectSshTargetsForCurrentUser" frontend/src`: rỗng. `tsc --noEmit`: không phát sinh lỗi
mới (diff với baseline 147-dòng = rỗng). Không có gì khác biệt so với kế hoạch.
