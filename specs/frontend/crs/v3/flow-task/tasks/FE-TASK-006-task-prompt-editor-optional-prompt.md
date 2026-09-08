# FE-TASK-006: `TaskPromptEditor.tsx` — bỏ nút disable theo textarea, gửi `prompt` optimistic

**Domain:** flow-task
**Solution Ref:** FE-SOL-001 Phần 5
**Priority:** 🟠 P1
**Estimated:** 30 phút
**Status:** [ ] TODO

---

## Mục tiêu

`TaskPromptEditor.tsx`'s `runWithAgent()` (dòng 15-39) tự thú qua comment (dòng 24-25) rằng
`task.execute` không có param `prompt` — nội dung user gõ vào textarea **bị bỏ hoàn toàn**
(BUG-FE-TASKV1-004 mục 1), nhưng nút Run vẫn `disabled={isRunning || !prompt.trim()}` (dòng 52) —
UX nói dối: trông như textarea rỗng thì không cho chạy, nhưng thực ra nội dung textarea chưa bao
giờ được gửi dù có hay không.

## ⚠️ Hard blocker đã biết — backend chưa có field `prompt`, task này KHÔNG tự thêm

`TaskServiceExecuteRequest` (`backend-go/proto/orca/task/v1/task.proto:124-127`) xác nhận:

```protobuf
message TaskServiceExecuteRequest {
  string task_id = 1;
  string request_id = 2;
}
```

Không có `prompt`. Xác nhận thêm ở `wscompat` layer
(`backend-go/services/api-gateway/internal/adapter/wscompat/channels_automation_task.go:223-237`):
`task.execute`'s Go handler dùng `executeArgs{ TaskID, RequestID }` — decode qua
`json.Unmarshal` thường (không `DisallowUnknownFields`), nên **field lạ trong JSON gửi lên
(`prompt`, `projectId`, `worktreePath`, `traceId` hiện tại đều đã là field "lạ" với struct này) bị
âm thầm bỏ qua, không gây lỗi**. Gửi thêm `prompt` optimistic ở task này do đó an toàn trên
backend-go, nhưng **là no-op thật sự** cho tới khi `ExecuteRequest`'s proto có field này — việc
backend, theo dõi ở `specs/backend-go/bugs/task-v1`, KHÔNG làm ở task này.

**Trên Node backend** (đang chạy production song song theo CR-FLOW-TASK-004): `task.execute`'s
Zod schema — nếu dùng `.strict()` — CÓ THỂ reject field lạ. Cần xác nhận schema Node trước khi
coi việc gửi `prompt` là an toàn tuyệt đối trên mọi target; không chặn việc gửi ở backend-go target
(CR-004 Pha 0 đã chốt hướng viết theo shape backend-go).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/task/TaskPromptEditor.tsx` | MODIFY |
| `frontend/src/renderer/src/components/task/__tests__/TaskPromptEditor.test.tsx` | MODIFY |

## Các bước thực thi

### 1. Bỏ `disabled={... || !prompt.trim()}`, thêm note tĩnh (dòng 41-65)

```tsx
// Trước (dòng 50-63):
<Button
  onClick={runWithAgent}
  disabled={isRunning || !prompt.trim()}
  data-testid="run-agent-btn"
>
  {isRunning ? (<><Loader2 size={12} className="animate-spin mr-1" />Running...</>) : '▶ Run with Agent'}
</Button>

// Sau — nút không còn disable theo nội dung textarea (nội dung đó chưa từng được gửi thật sự),
// cộng 1 dòng chú thích tĩnh giải thích hành vi thật thay vì im lặng bỏ qua input như hiện tại.
<>
  <p className="text-xs text-muted-foreground" data-testid="prompt-override-note">
    Note: overriding the prompt for a single run requires backend support that is not deployed yet
    (see BUG-FE-TASKV1-004). This run will use the task's saved prompt template.
  </p>
  <Button onClick={runWithAgent} disabled={isRunning} data-testid="run-agent-btn">
    {isRunning ? (<><Loader2 size={12} className="animate-spin mr-1" />Running...</>) : '▶ Run with Agent'}
  </Button>
</>
```

### 2. Gửi `prompt` optimistic trong `runWithAgent()` (dòng 26-31)

```typescript
await callRuntimeRpc(target, 'task.execute', {
  taskId: task.id,
  projectId: project!.id,
  worktreePath: currentWorktree!.path,
  traceId: span.id,
  prompt: prompt.trim() || undefined, // no-op cho tới khi ExecuteRequest có field này ở backend
})
```

Giữ nguyên comment giải thích cũ (dòng 24-25) nhưng cập nhật để không còn nói "hoàn toàn bỏ qua"
— sửa thành phản ánh đúng trạng thái mới: field được gửi optimistic, backend hiện bỏ qua nó.

## Giới hạn đã biết — ghi rõ trong PR

- Đổi `disabled={... || !prompt.trim()}` → `disabled={isRunning}` là thay đổi hành vi UI **thấy
  được ngay** (nút không còn bị khoá bởi textarea trống) — bắt buộc 1 dòng trong PR description
  giải thích lý do (xem "Hard blocker" ở trên), vì đây là đảo ngược 1 case UX cũ.
- `prompt` gửi lên **không có tác dụng thật** cho tới khi backend thêm field — không quảng cáo
  tính năng "override prompt cho 1 lần chạy" đã hoạt động; note tĩnh trong UI đã nói rõ điều này
  cho người dùng cuối, PR description cần nói rõ tương tự cho reviewer.

## Test cases cần cover

```
TaskPromptEditor.test.tsx (sửa case cũ + thêm case mới)
├── Button KHÔNG disabled khi prompt rỗng (đảo ngược case cũ "disabled khi prompt rỗng" — nếu
│   file test hiện tại có case này, XOÁ/SỬA theo hành vi mới, không để 2 case mâu thuẫn)
├── note tĩnh data-testid="prompt-override-note" luôn render
└── runWithAgent gửi payload có field `prompt` (giá trị textarea, hoặc undefined nếu rỗng) — case
    mới, thêm cạnh 4 case tracing hiện có (không đổi 4 case đó)
```

Đọc lại `TaskPromptEditor.test.tsx` hiện tại trước khi sửa — bản đọc lúc viết task này (2026-09-08)
chỉ có 4 case về tracing (`start`/RPC payload cơ bản/`ok`/`fail`), **chưa có** case nào assert
`disabled` theo `prompt.trim()` — nếu case đó vẫn chưa tồn tại khi implement, chỉ cần THÊM 2 case
mới ở trên, không cần xoá case nào.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/task/__tests__/TaskPromptEditor.test.tsx
cd frontend && npx tsc --noEmit -p .
```

## gitnexus

Chạy trước khi sửa (bắt buộc theo CLAUDE.md):
```
impact({target: "TaskPromptEditor", direction: "upstream"})
```
Kỳ vọng risk LOW — chỉ `TaskDetail.tsx`'s tab "ai" render component này (dòng 176). Dán kết quả
thật vào PR.

## Depends on
Không có

## Blocking
Không có
