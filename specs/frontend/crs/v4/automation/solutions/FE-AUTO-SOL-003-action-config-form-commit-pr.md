# FE-AUTO-SOL-003: `AutomationActionConfigForm` — khởi tạo component chung + form `commit_push`/`create_pr`

> **🔲 Designed — chưa implement.** Phụ thuộc cứng FE-AUTO-SOL-002.

**CR:** [CR-AUTO-003](../../../../../../docs/crs/v4/automations/CR-AUTO-003-action-executors-commit-pr.md)
**backend-go counterpart:** [BE-AUTO-SOL-003](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-003-action-executors-commit-pr.md)
**TDD tham chiếu:** không có mục riêng cho automation UI ở `specs/frontend/tdd` — dùng `docs/ui/pages/automations.md` (đã xác nhận mô tả đúng `AutomationsPage.tsx` thật) làm tham chiếu UI hiện có

---

## 1. Trạng thái hiện tại

`AutomationEditorDialog.tsx` chỉ có form cho 1 automation kiểu cũ (prompt
+ agentId + schedule). Không UI nào cho phép chọn/cấu hình action type.

## 2. Giải pháp

### Component mới: `AutomationActionConfigForm` (dùng chung 003 + 004)

```tsx
// frontend/src/renderer/src/components/automations/AutomationActionConfigForm.tsx
type Props = {
  action: AutomationAction
  onChange: (next: AutomationAction) => void
}
export function AutomationActionConfigForm({ action, onChange }: Props): JSX.Element {
  switch (action.type) {
    case 'commit_push': return <CommitPushActionFields config={action.config} onChange={...} />
    case 'create_pr': return <CreatePrActionFields config={action.config} onChange={...} />
    case 'run_script': return <RunScriptActionFields config={action.config} onChange={...} /> // FE-AUTO-SOL-004
    case 'send_notification': return <SendNotificationActionFields config={action.config} onChange={...} /> // FE-AUTO-SOL-004
    // 'create_worktree'/'run_agent': tái dùng field đã có trong AutomationEditorDialog hiện tại
  }
}
```

### `CommitPushActionFields`

Input `message` (text, hỗ trợ placeholder gợi ý biến `{{automation.name}}`
nếu CR-AUTO-003's template engine đơn giản được implement — nếu không,
chỉ string tĩnh cho v1), checkbox `push` (default checked).

### `CreatePrActionFields`

Input `title`, textarea `body` (optional), select `base` (danh sách
branch — tái dùng component chọn branch đã có ở nơi khác trong app, vd.
`AutomationProjectCombobox.tsx`'s pattern hoặc component chọn branch của
PR-creation flow hiện có, không tự vẽ mới), checkbox "Draft PR" (default
checked — theo CR-AUTO-003's khuyến nghị giảm rủi ro spam PR).

### Action list UI trong `AutomationEditorDialog.tsx`

Thêm 1 danh sách có thứ tự (drag-to-reorder nếu component sẵn có trong
design system, không thì mũi tên lên/xuống đơn giản cho v1), nút "+ Add
action" mở dropdown chọn action type, mỗi action render qua
`AutomationActionConfigForm`. Checkbox "Continue on failure" per-action
(map `continueOnFailure`).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng FE-AUTO-SOL-002 | Cao | Cần `AutomationAction` type tồn tại |
| Component chọn branch chưa xác nhận có sẵn tái dùng được | Trung bình | Khảo sát trước khi code, không tự vẽ mới nếu đã có |
| `AutomationEditorDialog.tsx` đã 2991 dòng cho `AutomationsPage.tsx` tổng — thêm action list UI có thể vi phạm `max-lines` | Trung bình | Theo AGENTS.md's "Lint Rules: Do Not Disable Max Lines" — tách file mới (`AutomationActionList.tsx`) thay vì nhồi vào file đã lớn, không xin exception baseline |

## Không thuộc phạm vi solution này

- `run_script`/`send_notification` fields — xem
  [FE-AUTO-SOL-004](./FE-AUTO-SOL-004-action-config-form-script-notification.md).

## Liên quan

- `frontend/src/renderer/src/components/automations/AutomationEditorDialog.tsx`
- `frontend/src/renderer/src/components/automations/AutomationProjectCombobox.tsx` (pattern tham chiếu)
- `docs/ui/pages/automations.md`
- [FE-AUTO-SOL-002](./FE-AUTO-SOL-002-actions-type-plumbing.md) (phụ thuộc cứng)
