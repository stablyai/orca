# FE-AUTO-SOL-004: Form `run_script`/`send_notification` — mở rộng `AutomationActionConfigForm`

> **🔲 Designed — chưa implement.** Phụ thuộc cứng FE-AUTO-SOL-002 +
> FE-AUTO-SOL-003 (component chung).

**CR:** [CR-AUTO-004](../../../../../../docs/crs/v4/automations/CR-AUTO-004-action-executors-script-notification.md)
**backend-go counterpart:** [BE-AUTO-SOL-004](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-004-action-executors-script-notification.md)

---

## 1. Giải pháp

### `RunScriptActionFields`

Textarea `script`, key-value editor `env` (tái dùng component key-value
đã có ở nơi khác trong Settings nếu tồn tại, vd. env var editor cho dev
server config — không tự vẽ mới nếu đã có).

### `SendNotificationActionFields`

Trước khi khoá field `channel`: đọc `docs/features/F11-notifications.md`
xác nhận model channel hiện tại (dropdown cố định hay free-text) — CR-AUTO-004
tự ghi rõ yêu cầu này, không bỏ qua. Textarea `message`.

## 2. Cảnh báo hiển thị cho `run_script`

Theo CR-AUTO-004's rủi ro "chạy shell command tuỳ ý qua automation tự
động" — thêm 1 dòng cảnh báo nhỏ trong form (không phải blocking dialog,
chỉ là context giúp user hiểu rủi ro trước khi lưu automation có action
này) — tham khảo cách UI đã cảnh báo cho `ephemeralVm`'s recipe command
tương tự nếu có pattern sẵn.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng FE-AUTO-SOL-002/003 | Cao | |
| `channel` model chưa xác nhận khớp F11 | Trung bình | Xem mục 1, bắt buộc khảo sát trước khi code UI |
| Ship trước khi SOL-AG-AUTO-001 xác nhận contract `notification.send` | Trung bình | UI có thể ship trước (không phụ thuộc code), nhưng action `send_notification` không nên bật thật cho user tới khi backend-go's BE-AUTO-SOL-004 xác nhận sẵn sàng (xem CR đó mục 3) |

## Không thuộc phạm vi solution này

- `commit_push`/`create_pr` fields — xem
  [FE-AUTO-SOL-003](./FE-AUTO-SOL-003-action-config-form-commit-pr.md).

## Liên quan

- `docs/features/F11-notifications.md`
- [FE-AUTO-SOL-002](./FE-AUTO-SOL-002-actions-type-plumbing.md), [FE-AUTO-SOL-003](./FE-AUTO-SOL-003-action-config-form-commit-pr.md) (phụ thuộc cứng)
- [BE-AUTO-SOL-004](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-004-action-executors-script-notification.md)
