# FE-AUTO-SOL-002: `actions?: AutomationAction[]` — type plumbing

> **🔲 Designed — chưa implement.** Phụ thuộc cứng BE-AUTO-SOL-002 (backend-go).

**CR:** [CR-AUTO-002](../../../../../../docs/crs/v4/automations/CR-AUTO-002-multi-action-chain-data-model.md)
**backend-go counterpart:** [BE-AUTO-SOL-002](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-002-multi-action-chain-data-model.md)
**TDD tham chiếu:** [TDD-FE-03](../../../../tdd/v5/03-runtime-client-layer.md) §2

---

## 1. Trạng thái hiện tại

`automations-types.ts`'s `Automation` không có `actions`. UI hiện tại
(`AutomationEditorDialog.tsx`) chỉ có 1 `prompt`+`agentId` field, không
concept "nhiều action".

## 2. Giải pháp

### Type mới, khớp BE-AUTO-SOL-002's proto

```ts
// frontend/src/shared/automations-types.ts
export type AutomationActionType =
  | 'create_worktree' | 'run_agent' | 'commit_push' | 'create_pr' | 'send_notification' | 'run_script'

export type AutomationAction = {
  id: string
  type: AutomationActionType
  config: Record<string, unknown> // opaque theo type, decode cụ thể ở form component từng loại (FE-AUTO-SOL-003/004)
  continueOnFailure?: boolean
}

export type Automation = {
  // ... field hiện có giữ nguyên ...
  actions?: AutomationAction[] // optional — automation cũ (1 prompt) không có field này
}
```

### `automation-host-client.ts`'s decode

`createAutomationForTarget`/`updateAutomationForTarget` cần forward
`actions` trong `toRuntimeAutomationCreateInput`/`toRuntimeAutomationUpdateInput`
khi gọi `callRuntimeRpc` — hiện 2 hàm này chỉ map `projectId`/`workspaceId`,
cần thêm field `actions` pass-through (JSON serialize, backend-go's
`config_json` là string, xác nhận `callRuntimeRpc`'s JSON marshaling tự
động xử lý nested object hay cần `JSON.stringify` field `config` thủ
công trước khi gửi — kiểm tra 1 ví dụ tương tự đã có, vd. cách
`ephemeralVm`'s recipe object nested được gửi qua cùng cơ chế).

### `AutomationRun`'s `actionResults`

```ts
export type AutomationRun = {
  // ... field hiện có ...
  actionResults?: Array<{ actionId: string; status: string; outputJson?: string; error?: string }>
}
```

## 3. Không cần đổi UI form trong solution này

`AutomationEditorDialog.tsx`'s form hiện tại (1 prompt) tiếp tục hoạt
động — khi submit, map thành `actions: [{id: 'primary', type: 'run_agent',
config: {prompt, agentId}}]` (1-action chain) cho tới khi
FE-AUTO-SOL-003/004 thêm UI chọn nhiều action. Đây là bước trung gian an
toàn: type đã sẵn sàng, backend đã hiểu `actions[]`, nhưng UI multi-action
chưa cần ship cùng lúc.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng BE-AUTO-SOL-002 | Cao | `actions` field phải tồn tại ở backend-go trước, nếu không renderer gửi field backend không hiểu (bị bỏ qua âm thầm, không lỗi rõ ràng — proto3 field lạ) |
| `config`'s JSON serialize qua `callRuntimeRpc` chưa xác nhận | Trung bình | Cần kiểm tra ví dụ tương tự trước khi code, không giả định |

## Không thuộc phạm vi solution này

- UI chọn/sắp xếp nhiều action — xem
  [FE-AUTO-SOL-003](./FE-AUTO-SOL-003-action-config-form-commit-pr.md)/[004](./FE-AUTO-SOL-004-action-config-form-script-notification.md).

## Liên quan

- `frontend/src/shared/automations-types.ts:18,136` (field hiện có)
- `frontend/src/renderer/src/components/automations/automation-host-client.ts:64-77` (`toRuntimeAutomationCreateInput`/`toRuntimeAutomationUpdateInput`)
- [BE-AUTO-SOL-002](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-002-multi-action-chain-data-model.md) (phụ thuộc cứng)
