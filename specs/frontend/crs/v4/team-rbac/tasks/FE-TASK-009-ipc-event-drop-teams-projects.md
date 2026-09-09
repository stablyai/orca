# FE-TASK-009: `useIpcEvents.ts`'s `onAuthStateChanged` + preload type bỏ `teams`/`projects`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) Phần A
**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Priority:** 🔴 P0
**Estimated:** 15 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

`useIpcEvents.ts`'s `onAuthStateChanged` handler (~dòng 2945-2960) là nơi hard-code `teams:
event.user.teams, projects: event.user.projects` khi gọi `store.setCurrentUser(...)`. Kênh IPC này
xác nhận **không có emitter thật** trong `backend/src/main` (dead plumbing) — sửa chỉ để hết lỗi
compile sau khi `OrcaUser` bỏ field (FE-TASK-007).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/hooks/useIpcEvents.ts` | MODIFY — `onAuthStateChanged` handler (~dòng 2945-2960) |
| `frontend/src/preload/api-types.ts` | MODIFY — bỏ `teams`/`projects` khỏi type tham số `event.user` của `onAuthStateChanged` |

## Các bước thực thi

**`useIpcEvents.ts`:** trong `onAuthStateChanged` handler, bỏ `teams: event.user.teams, projects:
event.user.projects` khỏi object literal truyền cho `store.setCurrentUser({...})`.

**`api-types.ts`:** bỏ `teams`/`projects` khỏi type khai báo `event.user` của `onAuthStateChanged`.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -n "event.user.teams\|event.user.projects" frontend/src/renderer/src/hooks/useIpcEvents.ts
```

## Lưu ý xung đột file

`frontend/src/preload/api-types.ts` cũng bị sửa bởi **FE-TASK-003** (SOL-001, sửa field `role`
trong cùng type `onAuthStateChanged`'s `event.user`) — làm FE-TASK-003 **trước** task này để tránh
2 patch cùng đụng 1 khối type khi áp dụng tuần tự.

## Depends on

FE-TASK-007 (cần `OrcaUser` đã bỏ field trước). FE-TASK-003 nên làm trước (xem "Lưu ý xung đột
file").

## Blocking

Không có.

## Kết quả thực tế (2026-09-09)

Xác nhận vị trí thật bằng `grep -n "onAuthStateChanged\|event.user.teams\|event.user.projects"
frontend/src/renderer/src/hooks/useIpcEvents.ts` — handler thật ở dòng 2945-2962 (khớp "~2945-2960"
ghi trong task). FE-TASK-003 đã làm trước (sửa field `role` trong cùng khối type ở `api-types.ts`)
đúng theo khuyến nghị "Lưu ý xung đột file" — áp dụng tuần tự không conflict.

Đã bỏ `teams: event.user.teams, projects: event.user.projects` khỏi object literal truyền cho
`store.setCurrentUser(...)` trong `useIpcEvents.ts`, và bỏ `teams: string[]` / `projects: string[]`
khỏi type tham số `event.user` của `onAuthStateChanged` trong `frontend/src/preload/api-types.ts`
(cùng khối đã sửa field `role` ở FE-TASK-003, dòng 3404-3418).

`grep -n "event.user.teams\|event.user.projects"` trên `useIpcEvents.ts`: rỗng. `tsc --noEmit`:
không phát sinh lỗi mới (kết hợp cùng FE-TASK-007/008, diff với baseline 147-dòng = rỗng). Test
liên quan `useIpcEvents.test.ts`: chạy độc lập cho thấy 53/73 test đã fail **trước khi có bất kỳ
thay đổi nào của nhóm B** (xác nhận bằng `git stash` cô lập đúng 4 file liên quan rồi chạy lại) —
tất cả đều lỗi `TypeError: useAppStore is not a function` ở `useDevServersSync`, không liên quan gì
đến `onAuthStateChanged`/`teams`/`projects` — là lỗi test-infra có sẵn từ trước, không do task này
gây ra, không sửa (ngoài phạm vi 13 task được giao). Không có gì khác biệt so với kế hoạch.
