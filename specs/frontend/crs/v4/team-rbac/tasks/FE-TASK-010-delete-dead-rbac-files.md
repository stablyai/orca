# FE-TASK-010: Xoá 2 file dead code — `UserProfileBadge.tsx` + `shared/rbac-types.ts`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) Phần A
**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Priority:** 🔴 P0
**Estimated:** 15 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

2 file dead code phát hiện thêm ngoài audit gốc, cả 2 đã xác nhận qua `impact()`/`grep`:

- `frontend/src/renderer/src/components/activity/UserProfileBadge.tsx` — đọc `user.teams` để
  render badge, nhưng `impact()` xác nhận impactedCount = 0 (0 import/render ở đâu cả — khác hẳn
  `UserAvatarMenu.tsx`, component avatar thật đang sống).
- `frontend/src/shared/rbac-types.ts` — định nghĩa `OrcaUser`/role 3-valued riêng, trùng lặp với
  `store/slices/auth.ts`; `grep` xác nhận 0 file import.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/activity/UserProfileBadge.tsx` | DELETE |
| `frontend/src/shared/rbac-types.ts` | DELETE |

## Các bước thực thi

1. Xác nhận lại 0 caller trước khi xoá (bắt buộc theo quy tắc repo):
   `gitnexus impact({target:"UserProfileBadge", direction:"upstream"})` — kỳ vọng impactedCount = 0
   (đã xác nhận ở solution, chạy lại 1 lần nữa ngay trước khi xoá).
2. `grep -rln "rbac-types" frontend/src` — kỳ vọng rỗng, xác nhận `shared/rbac-types.ts` không còn
   ai import.
3. Xoá cả 2 file.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -rn "UserProfileBadge\|shared/rbac-types" frontend/src
```

Grep phải rỗng sau khi xoá (trừ chính lịch sử git).

## Lưu ý

Nếu về sau cần khôi phục ý tưởng RBAC types dùng chung, tạo lại với tên rõ ràng hơn
(`orca-team-rbac-types.ts`) thay vì khôi phục file trùng tên với `OrcaUser` ở
`store/slices/auth.ts`. **Ngoại lệ:** nếu FE-SOL-006 (SAML, xem FE-TASK-027) sau này cần
`OrcaSsoConfig` từng khai ở `rbac-types.ts`, phải xác nhận lại vị trí đúng để chuyển type đó sang
1 file sống trước khi xoá — theo ghi chú của FE-SOL-006. Tại thời điểm task này, `grep` xác nhận
0 importer nên xoá an toàn ngay.

## Depends on

Không có.

## Blocking

Không có.

## Kết quả thực tế (2026-09-09)

Xác nhận lại ngay trước khi xoá:
- `impact({target: "UserProfileBadge", direction: "upstream"})`: `impactedCount = 0, risk: "LOW"`.
- `impact({target: "resolveUserPermissions", direction: "upstream"})` (hàm chính trong
  `rbac-types.ts`, `impact()` không nhận file `rbac-types` làm target trực tiếp vì đây không phải
  1 symbol callable): `frontend/src/shared/rbac-types.ts`'s bản `impactedCount = 0, risk: "LOW"`
  (trong số 4 candidate trùng tên ở agent/backend/desktop/frontend — mỗi service có file
  `rbac-types.ts` riêng, đều dead, nhưng task này chỉ xoá bản `frontend/`).
- `grep -rln "UserProfileBadge\|rbac-types" frontend/src`: chỉ khớp chính 2 file sắp xoá.

Đã xoá cả 2 file: `frontend/src/renderer/src/components/activity/UserProfileBadge.tsx` và
`frontend/src/shared/rbac-types.ts`. Không có file test riêng cho 2 file này (`find -iname` rỗng).

`grep -rn "UserProfileBadge\|shared/rbac-types" frontend/src`: rỗng sau khi xoá. `tsc --noEmit`:
không phát sinh lỗi mới (diff với baseline 147-dòng = rỗng). Không có gì khác biệt so với kế hoạch —
không phát sinh nhu cầu giữ lại `OrcaSsoConfig` cho FE-SOL-006 vì FE-TASK-027 không nằm trong phạm
vi 13 task lần này.
