# FE-TASK-AUTO-004: `run_script`/`send_notification` fields

**Solution:** [FE-AUTO-SOL-004](../solutions/FE-AUTO-SOL-004-action-config-form-script-notification.md) | **CR:** CR-AUTO-004
**Depends on:** [FE-TASK-AUTO-003](./FE-TASK-AUTO-003-action-config-form-commit-pr.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Hoàn thiện 2 case còn lại trong `AutomationActionConfigForm`.

## Files cần sửa

1. `frontend/src/renderer/src/components/automations/RunScriptActionFields.tsx` (MỚI)
2. `frontend/src/renderer/src/components/automations/SendNotificationActionFields.tsx` (MỚI)
3. `frontend/src/renderer/src/components/automations/AutomationActionConfigForm.tsx` (MODIFY — thêm 2 case)

## Bước 1 — Đọc F11 channel model trước khi khoá field `channel`

Đọc `docs/features/F11-notifications.md` xác nhận model channel (dropdown
cố định hay free-text). Không tự đặt tên channel mới không khớp F11.

## Nội dung

- `RunScriptActionFields`: textarea `script`, key-value editor `env`
  (tái dùng component key-value đã có trong Settings nếu tồn tại), 1
  dòng cảnh báo nhỏ về rủi ro chạy shell command tuỳ ý (không phải
  blocking dialog).
- `SendNotificationActionFields`: field `channel` theo đúng model F11
  (bước 1), textarea `message`.

## Test cases cần cover

- Thêm action `run_script` → render đúng field, cảnh báo hiển thị.
- Thêm action `send_notification` → field `channel` khớp model F11.
- Env var editor (key-value) → thêm/xoá/sửa entry cập nhật đúng `config.env`.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/automations/AutomationActionConfigForm.test.tsx
npx tsc --noEmit
```

## gitnexus

`impact({target: "AutomationActionConfigForm", direction: "upstream"})`
— xác nhận không phá 2 case đã thêm ở FE-TASK-AUTO-003.

---

## ✅ Kết quả thực tế (2026-09-09)

### Bước 1 — F11 channel model: KHÔNG có taxonomy cố định

Đọc `docs/features/F11-notifications.md` xác nhận: đây là 1 feature
KHÁC (in-app notification center + desktop OS notification cho trạng
thái agent — filter theo agent/worktree/severity), **không mô tả bất kỳ
khái niệm "channel" nào** liên quan tới `send_notification` action. Đọc
tiếp implementation thật ở `agent/src/relay/notification-send-handler.ts`
xác nhận `channel` là **free-text string**, mặc định `'default'` nếu
rỗng, chỉ dùng làm prefix hiển thị trong title thông báo OS
(`Orca (${channel})`) — không có enum/dropdown cố định nào ở tầng agent.
**Quyết định**: field `channel` là 1 `Input` free-text (không phải
dropdown), có 1 dòng chú thích ngắn giải thích đây không phải danh sách
kênh cố định — khớp đúng model thật, không tự đặt tên channel mới không
khớp F11 (đúng chỉ dẫn task).

### Env key-value editor — tái dùng thật, không tự vẽ mới

Tìm thấy `frontend/src/renderer/src/components/settings/agent-default-env-draft.ts`
(`parseAgentDefaultEnvDraft`/`stringifyAgentDefaultEnvDraft`) — đã dùng
thật cho field "Environment" của mỗi agent trong `AgentsPane.tsx`
(`AgentDefaultEnvInput`). Đây chính xác là "component key-value đã có
trong Settings" task yêu cầu tái dùng — 1 input dòng đơn cú pháp
`KEY=value KEY2=value2`, không phải UI dạng bảng nhiều dòng (không có
component đó trong repo). Tái dùng NGUYÊN `parseAgentDefaultEnvDraft`/
`stringifyAgentDefaultEnvDraft` cho `RunScriptActionFields`'s `env`
field, không viết logic parse/stringify mới.

### Nội dung đã làm

- `RunScriptActionFields.tsx` (MỚI): textarea `script`; `EnvEditor` nội
  bộ (tái dùng `agent-default-env-draft.ts`, commit khi blur/Enter, Esc
  để revert — cùng UX pattern `AgentDefaultEnvInput` đã có); 1 dòng cảnh
  báo nhỏ (icon `AlertTriangle`, không phải blocking dialog) về rủi ro
  chạy shell command tuỳ ý.
- `SendNotificationActionFields.tsx` (MỚI): field `channel` (Input
  free-text, placeholder `"default"`) + 1 dòng chú thích model thật
  (Bước 1); textarea `message`.
- `AutomationActionConfigForm.tsx` (MODIFY): thêm 2 case `run_script`/
  `send_notification`, render đúng field set mới — 2 case còn lại
  (`create_worktree`/`run_agent`) vẫn giữ placeholder cũ (không thuộc
  phạm vi task này, đúng doc comment component gốc).

### Test cases đã cover (khớp 3 mục sketch gốc)

`AutomationActionConfigForm.test.tsx` (4 test mới, cộng dồn 8 test tổng
trong file):
- `run_script` render đúng field + cảnh báo hiển thị, input `script` cập
  nhật đúng `config.script`.
- Env editor: thêm entry (`FOO=1` → `FOO=1 BAR=2`), sửa/xoá entry
  (`BAR=2` → chỉ còn `BAR=changed`, `FOO` bị xoá) — cả 2 thao tác cập
  nhật đúng `config.env`. **Phát hiện thật khi viết test**: commit qua
  React's `onBlur` cần dispatch sự kiện DOM `focusout` (không phải
  `blur` — `blur` không bubble, React's synthetic `onBlur` lắng nghe
  `focusout`), test ban đầu dùng `blur` fail vì `onChange` không bao giờ
  được gọi — sửa lại đúng, không đoán mà chạy test thật bắt lỗi này.
- `send_notification` render đúng field `channel` (khớp model F11) +
  `message`, cả 2 cập nhật đúng `config`.
- Cập nhật lại test cũ "returns a placeholder..." — đổi sang test
  `create_worktree` (thay vì `run_script`, giờ đã có field thật) để giữ
  đúng coverage cho 2 case còn chưa implement.

### Verify (chạy thật trong sandbox này)

```
cd frontend
npx vitest run src/renderer/src/components/automations/AutomationActionConfigForm.test.tsx
  # PASS 8/8 (4 cũ + 4 mới)
npx vitest run src/renderer/src/components/automations/
  # PASS 134/135 — 1 fail KHÔNG liên quan (automation-project-groups.test.ts,
  # file không đụng tới, tiền sự cố từ session khác trên cùng working
  # directory — đã xác nhận nhiều lần trước đó trong track này)
npx oxlint src/renderer/src/components/automations/RunScriptActionFields.tsx \
           src/renderer/src/components/automations/SendNotificationActionFields.tsx \
           src/renderer/src/components/automations/AutomationActionConfigForm.tsx \
           src/renderer/src/components/automations/AutomationActionConfigForm.test.tsx
  # sạch — 0 finding
npx tsc --noEmit -p .
  # 0 lỗi trong bất kỳ file task này đụng tới (grep xác nhận trên output
  # đầy đủ) — lỗi tsc khác thấy được trên toàn repo đều pre-existing,
  # không liên quan automations
```

**Files đã sửa/tạo:**
- `frontend/src/renderer/src/components/automations/RunScriptActionFields.tsx` (MỚI)
- `frontend/src/renderer/src/components/automations/SendNotificationActionFields.tsx` (MỚI)
- `frontend/src/renderer/src/components/automations/AutomationActionConfigForm.tsx` (MODIFY — 2 case mới)
- `frontend/src/renderer/src/components/automations/AutomationActionConfigForm.test.tsx` (MODIFY — 4 test mới, 1 test cũ cập nhật)
