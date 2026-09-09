# FE-TASK-AUTO-003: `AutomationActionConfigForm` + `commit_push`/`create_pr` fields

**Solution:** [FE-AUTO-SOL-003](../solutions/FE-AUTO-SOL-003-action-config-form-commit-pr.md) | **CR:** CR-AUTO-003
**Depends on:** [FE-TASK-AUTO-002](./FE-TASK-AUTO-002-actions-type-plumbing.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Component chung cho action config form (dùng tiếp ở FE-TASK-AUTO-004) +
UI action list có thứ tự trong editor dialog + 2 field set đầu tiên.

## Files cần sửa

1. `frontend/src/renderer/src/components/automations/AutomationActionConfigForm.tsx` (MỚI)
2. `frontend/src/renderer/src/components/automations/AutomationActionList.tsx` (MỚI — tách riêng, KHÔNG nhồi vào `AutomationEditorDialog.tsx` đã 2991 dòng)
3. `frontend/src/renderer/src/components/automations/CommitPushActionFields.tsx` (MỚI)
4. `frontend/src/renderer/src/components/automations/CreatePrActionFields.tsx` (MỚI)
5. `frontend/src/renderer/src/components/automations/AutomationEditorDialog.tsx` (MODIFY — chỉ thêm import + mount `AutomationActionList`, không thêm logic action vào file này)

## Bước 1 — Tìm component chọn branch có sẵn

Khảo sát component chọn branch đã dùng ở PR-creation flow hiện có
(`pull-request-generation.ts`'s UI liên quan) — tái dùng cho
`CreatePrActionFields`'s `base` field, không tự vẽ mới.

## Nội dung (xem FE-AUTO-SOL-003 §2)

- `AutomationActionConfigForm`: switch theo `action.type`, render field
  set tương ứng (2 case đầu ở task này: `commit_push`, `create_pr`; case
  còn lại throw/return null tạm thời, hoàn thiện ở FE-TASK-AUTO-004).
- `AutomationActionList`: danh sách action có thứ tự (mũi tên lên/xuống
  cho v1, không cần drag-drop), nút "+ Add action" (dropdown action
  type), checkbox `continueOnFailure` per-action.
- `CommitPushActionFields`: input `message`, checkbox `push` (default checked).
- `CreatePrActionFields`: input `title`, textarea `body`, chọn `base`
  (bước 1), checkbox "Draft PR" (default checked).

## Test cases cần cover

- Thêm action `commit_push` vào list → render đúng field, thay đổi field cập nhật đúng `action.config`.
- Thêm action `create_pr` → tương tự.
- Xoá/sắp xếp lại action trong list → thứ tự cập nhật đúng trong state.
- `continueOnFailure` toggle → cập nhật đúng field.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/automations/AutomationActionList.test.tsx src/renderer/src/components/automations/AutomationActionConfigForm.test.tsx
npx oxlint  # xác nhận không file nào vượt max-lines
npx tsc --noEmit
```

## gitnexus

`impact({target: "AutomationEditorDialog", direction: "upstream"})`
trước khi sửa — file này lớn, nhiều nơi phụ thuộc, sửa cẩn thận theo
đúng chỉ dẫn "chỉ thêm mount, không thêm logic".

---

## ✅ Kết quả thực tế (2026-09-09)

**Ghi chú thực thi**: task này được giao cho 1 agent chạy trong git
worktree cô lập (song song với FE-TASK-AUTO-006 để tăng tốc). Worktree đó
rẽ nhánh từ 1 điểm TRƯỚC KHI FE-TASK-AUTO-002 (và toàn bộ cây spec
`specs/frontend/crs/v4/automation/`) tồn tại trong repo — vì mọi việc
trong phiên làm việc này đều để ở trạng thái uncommitted theo đúng chỉ
dẫn, agent trong worktree cô lập không thấy được các thay đổi đó. Agent
tự phát hiện điều này và port-forward tối thiểu `AutomationActionType`/
`AutomationAction` vào bản `automations-types.ts` của worktree để
component mới compile được — **không cần thiết ở đây**: khi merge code
của agent vào working tree thật (nơi FE-TASK-AUTO-002 đã DONE với type
đầy đủ hơn — bao gồm `AutomationActionResult`, `Automation.actions?`/
`maxRunHistory?`/`runTimeoutSeconds?`, v.v.), các component mới compile
sạch trực tiếp trên type thật, không cần port-forward gì thêm — đã xác
nhận lại bằng `tsc --noEmit` sau khi merge (xem Verify).

### Phát hiện 1 — `AutomationEditorDialog.tsx` thực tế đã KHÔNG còn 2991 dòng

Task/solution doc gốc (viết từ 1 thời điểm trước) mô tả file này "2991
dòng". Thực tế file chỉ còn **~200 dòng** — đã được tách sẵn thành
`AutomationEditorDialogHeader.tsx`/`AutomationEditorPromptSection.tsx`/
`AutomationEditorDialogFooter.tsx` từ trước (không phải do task này).
Không ảnh hưởng cách làm — vẫn tuân thủ đúng chỉ dẫn "chỉ thêm mount,
tách file riêng cho action list" vì đó là kiến trúc đúng bất kể số dòng
hiện tại.

### Phát hiện 2 — Bước 1 (khảo sát branch-picker): dùng `CreateFromPicker.tsx`, KHÔNG dùng field trong `CreateHostedReviewComposerFields.tsx`

Khảo sát theo đúng chỉ dẫn ("quanh `pull-request-generation.ts`'s UI
liên quan"): `pull-request-generation.ts` bản thân chỉ build prompt AI,
không có UI. UI thật của PR-creation flow dùng nó là
`SourceControlTextGenerationDialog.tsx`/`SourceControl.tsx` qua
`useCreatePullRequestDialogFields.ts` + `CreateHostedReviewComposerFields.tsx` —
field `base` ở đó là 1 `<input>` + dropdown kết quả tự vẽ, gắn chặt vào
hook AI-generation (state `generating`/`createError`/`baseSameAsBranch`…)
không tách được thành component branch-picker độc lập mà không kéo theo
toàn bộ state không liên quan tới action-config form.

Tìm tiếp trong chính thư mục `automations/` phát hiện
`CreateFromPicker.tsx` — component Popover+Command chọn branch **đã tồn
tại sẵn, độc lập** (props chỉ `repoId`/`repoMap`/`worktrees`/`value`/
`onValueChange`, không phụ thuộc PR-generation state gì), **đã đang được
dùng thật** trong `AutomationEditorDialogFooter.tsx` cho field
`draft.baseBranch` của chính automation (branch tạo workspace từ đó).
Đây là lựa chọn đúng tinh thần "tái dùng, không tự vẽ mới" hơn — cùng
domain (automations), cùng nguồn dữ liệu branch (`searchRuntimeRepoBaseRefs`
qua `runtime-repo-client`), không kéo theo dependency ngoài phạm vi.
**Quyết định**: `CreatePrActionFields`'s `base` field tái dùng
`CreateFromPicker` trực tiếp (nhận thêm `repoId`/`repoMap`/`worktrees`
truyền xuống từ `AutomationActionList` ← `AutomationEditorDialog`, vốn
đã có sẵn các prop này).

### Phát hiện 3 — `AutomationActionList` để state tự quản (uncontrolled), không controlled qua `AutomationEditorDialog`

Chỉ dẫn "không thêm logic/state action vào `AutomationEditorDialog.tsx`"
loại bỏ khả năng file đó giữ `useState<AutomationAction[]>` rồi truyền
xuống dạng controlled (khác pattern `value`/`onValueChange` của
`CreateFromPicker`/`AutomationProjectCombobox`). Giải pháp:
`AutomationActionList` tự giữ `actions` bằng `useState` nội bộ (khởi tạo
từ `initialActions` optional), và báo ra ngoài qua `onActionsChange`
optional (không bắt buộc dùng) — cho phép mount ở `AutomationEditorDialog.tsx`
chỉ với 3 prop đã có sẵn (`repoId`/`repoMap`/`worktrees`), zero state mới
ở file đó, đồng thời vẫn testable đầy đủ (test truyền `initialActions` +
spy `onActionsChange`, assert state kế tiếp sau mỗi thao tác). **Lưu ý
mở**: việc nối `actions` từ list này vào `AutomationDraft`/luồng save
thật (`AutomationsPage.tsx` → `automation-host-client.ts`'s `actions`
field, đã sẵn sàng nhận từ FE-TASK-AUTO-002) là việc của 1 task khác
chưa được giao trong phạm vi này — hiện tại `AutomationActionList` render
được, test được, nhưng chưa có gì đọc `onActionsChange`'s output để lưu
lại khi bấm Save.

### Nội dung đã làm (đúng phạm vi gốc)

- `AutomationActionConfigForm.tsx`: switch theo `action.type`; case
  `commit_push`/`create_pr` render field set thật; case
  `run_script`/`send_notification`/`create_worktree`/`run_agent` render
  placeholder "chưa có cấu hình" (4 case còn lại đều rơi vào 1 nhánh
  return, không throw — throw sẽ crash cả action list nếu 1 action cũ có
  type chưa hỗ trợ).
- `CommitPushActionFields.tsx`: input `message` (đọc/ghi `config.message`),
  checkbox `push` default-checked (`config.push !== false`).
- `CreatePrActionFields.tsx`: input `title`, textarea `body`, `CreateFromPicker`
  cho `base`, checkbox "Create as draft PR" default-checked
  (`config.draft !== false`, khớp CR-AUTO-003's khuyến nghị giảm rủi ro
  spam PR).
- `AutomationActionList.tsx`: dropdown "+ Add action" (6 action type,
  `DropdownMenu`), mỗi row có mũi tên lên/xuống (disable ở biên), nút xoá,
  `AutomationActionConfigForm`, checkbox "Continue on failure" — tất cả
  qua `Checkbox`/`Button`/`DropdownMenu` shadcn primitives có sẵn, không
  tự tạo màu/spacing mới.
- `AutomationEditorDialog.tsx`: thêm 1 import + mount
  `<AutomationActionList repoId={draft.projectId} repoMap={repoMap} worktrees={worktrees} />`
  giữa `AutomationEditorPromptSection` và `AutomationEditorDialogFooter`,
  bọc trong `<div className="border-t border-border px-5 py-4">` khớp
  spacing convention có sẵn trong file. Không thêm state/logic action nào
  khác vào file này (đúng chỉ dẫn).

### Test cases đã cover (khớp 4 mục sketch gốc)

`AutomationActionConfigForm.test.tsx` (5 test):
- render `commit_push` fields + input message → `onChange` nhận đúng
  `action.config.message` mới (giữ nguyên các field khác).
- checkbox `push` default checked; uncheck → `config.push === false`.
- render `create_pr` fields + input title/body/base (base qua
  `CreateFromPicker` — mock stub, hành vi thật của nó đã test riêng ở
  `CreateFromPicker.test.tsx`) → `onChange` nhận đúng từng field.
- checkbox "draft" default checked; uncheck → `config.draft === false`.
- action type chưa hỗ trợ (`run_script`) → render placeholder, không throw.

`AutomationActionList.test.tsx` (4 test):
- thêm action `commit_push` từ dropdown → list rỗng → 1 phần tử, field
  set đúng render theo (input `message` xuất hiện trên DOM).
- mũi tên lên/xuống → thứ tự `actions[]` báo ra qua `onActionsChange` đổi
  đúng (đi xuống rồi lên lại, xác nhận cả 2 chiều).
- nút xoá → action bị loại khỏi `actions[]` báo ra.
- checkbox "Continue on failure" ở đúng action (không phải action đầu) →
  chỉ field đó đổi, các action khác giữ nguyên.

### Verify (chạy thật, sau khi merge vào working tree thật — không phải worktree cô lập)

```
cd frontend
npx vitest run src/renderer/src/components/automations/AutomationActionList.test.tsx src/renderer/src/components/automations/AutomationActionConfigForm.test.tsx
  # PASS 9/9 (5 + 4)
npx tsc --noEmit -p .
  # 0 lỗi trong bất kỳ file automations-liên-quan (đã kiểm tra không cần
  # port-forward type nào — dùng thẳng type thật từ FE-TASK-AUTO-002)
```

**Files đã sửa/tạo:**
- `frontend/src/renderer/src/components/automations/AutomationActionConfigForm.tsx` (MỚI)
- `frontend/src/renderer/src/components/automations/AutomationActionList.tsx` (MỚI)
- `frontend/src/renderer/src/components/automations/CommitPushActionFields.tsx` (MỚI)
- `frontend/src/renderer/src/components/automations/CreatePrActionFields.tsx` (MỚI)
- `frontend/src/renderer/src/components/automations/AutomationActionConfigForm.test.tsx` (MỚI)
- `frontend/src/renderer/src/components/automations/AutomationActionList.test.tsx` (MỚI)
- `frontend/src/renderer/src/components/automations/AutomationEditorDialog.tsx` (MODIFY — 1 import + 1 mount block)
