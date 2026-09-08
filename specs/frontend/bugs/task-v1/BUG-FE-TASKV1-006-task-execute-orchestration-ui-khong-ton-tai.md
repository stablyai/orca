# BUG-FE-TASKV1-006 — Task Execute/Orchestration (Engine 2): không có UI điều phối thật, `OrchestrationPage.tsx` chỉ là storyboard marketing

**Mức độ:** 🔴 Critical
**Status:** 🔴 Open
**Module:** `frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationPage.tsx`, `components/terminal-pane/terminal-orchestration-task-links.ts`
**Phát hiện:** 2026-09-08 (audit frontend vs 3 hệ Task: OrcaTask/Task Execute/Workflow Orchestration)

---

## Mô tả

Không tồn tại component nào tên `TaskRow` trong toàn bộ `frontend/src` (grep
`TaskRow` — 0 kết quả) — không có UI dạng bảng/danh sách hiển thị các dispatch
record của orchestration-service (coordinator/dispatch/message) theo hàng như
tên gợi ý.

`OrchestrationPage.tsx` (`components/feature-wall/agents-orchestration/`) —
nơi duy nhất trong codebase có chữ "Orchestration" ở tên component lớn — đọc
kỹ toàn bộ 417 dòng thì đây là 1 **storyboard hoạt hình dàn dựng cho trang
marketing** ("feature wall"), không phải UI điều phối task thật:

- Toàn bộ state (`rowState`, `rowMessages`, `rowFlash`, `rowPending`,
  `createdChildCount`) là dữ liệu **hardcode** từ `orchestration-types.ts`
  (`INITIAL_ROW_STATE`, `INITIAL_ROW_MESSAGES`, `PHASE1_BEATS`, các mốc thời
  gian `ORCHESTRATION_CLI_COMMAND_TIMINGS_MS`) — không phải dữ liệu thật từ
  backend.
- Tên task/PR hiển thị (`"redesign auth flow"`, `"PR 1/2: migrate users.sql"`,
  `"PR 2/2: withSession middleware"`) là chuỗi tĩnh viết cứng trong JSX
  (dòng 295, 354, 379), không đọc từ bất kỳ RPC nào.
- Toàn bộ animation (bubble bay giữa 2 row, arrow vẽ SVG, reveal child
  workspace) chạy bằng `setTimeout`/`requestAnimationFrame` theo timeline cố
  định (`runOnce()`, `loop()`, dòng 219-276) — có `loop()` tự lặp lại vô hạn
  để làm demo GIF-như-video trên landing page.
- File có `oxlint-disable` với comment tự thú ngay dòng 1: *"this page is a
  timed storyboard; row state resets are part of replaying the animation"*.
- **0 lời gọi `callRuntimeRpc` trong toàn bộ file** — xác nhận không có kết
  nối gì tới backend orchestration-service thật.

Phần **duy nhất hoạt động thật** liên quan tới orchestration trong toàn bộ
frontend là `terminal-orchestration-task-links.ts`
(`components/terminal-pane/`): parse chuỗi `task_xxxx` xuất hiện trong output
terminal (regex-based, `extractOrchestrationTaskLinks()`), khi user click vào
token đó thì `focusRuntimeOrchestrationTask()` gọi RPC thật
`orchestration.dispatchShow` (dòng 59-61) để lấy `assignee_handle`, rồi focus
đúng terminal đang chạy dispatch đó (`terminal.focus`, dòng 71) — đây là 1
tiện ích điều hướng nhỏ (click link trong log để nhảy tới terminal tương ứng),
**không phải** 1 dashboard hay UI quản lý coordinator/dispatch/message nào.

## Hậu quả

- Toàn bộ hệ Task Execute/Orchestration (Engine 2 trong mô hình 3-engine của
  `CR-FLOW-TASK-001`) **không có UI vận hành thật nào** — người dùng không
  thể xem danh sách dispatch đang chạy, không xem được message giữa
  coordinator/agent, không huỷ/retry được 1 dispatch, không có bất kỳ hình
  thức giám sát nào ngoài việc tự đọc log terminal thô và click từng
  `task_xxxx` token thủ công.
- `OrchestrationPage.tsx` (component duy nhất có tên gợi ý "orchestration")
  chỉ để trình diễn concept cho khách hàng xem trên landing page, hoàn toàn
  tách biệt khỏi engine thật đang chạy dưới nền.
- Rủi ro hiểu nhầm cao trong nội bộ team: tên file/thư mục
  (`agents-orchestration/OrchestrationPage.tsx`) rất dễ khiến người review
  code hoặc onboard mới tưởng đây là UI điều phối thật, dẫn tới ước tính sai
  mức độ hoàn thiện của Engine 2 ở tầng frontend.

## Bằng chứng

```
frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationPage.tsx:1     → oxlint-disable comment tự thú "this page is a timed storyboard"
frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationPage.tsx:295,354,379 → tên task/PR viết cứng trong JSX ("redesign auth flow", "PR 1/2: migrate users.sql", ...)
frontend/src/renderer/src/components/feature-wall/agents-orchestration/OrchestrationPage.tsx (toàn file) → 0 lời gọi callRuntimeRpc — xác nhận không kết nối backend thật
frontend/src/renderer/src/components/terminal-pane/terminal-orchestration-task-links.ts:50-72       → focusRuntimeOrchestrationTask() gọi THẬT orchestration.dispatchShow rồi terminal.focus — phần DUY NHẤT hoạt động thật của cụm này
grep -rln "TaskRow" frontend/src                                                                     → 0 kết quả, xác nhận không có component bảng dispatch nào
```

## Đề xuất fix

1. Đổi tên `OrchestrationPage.tsx` hoặc di chuyển ra khỏi ngữ cảnh dễ nhầm — cân nhắc namespace rõ ràng hơn (ví dụ giữ trong `feature-wall/` nhưng đặt tên `OrchestrationStoryboard.tsx`) để tránh nhầm với UI vận hành thật khi tìm kiếm code.
2. Thiết kế + implement 1 dashboard Engine 2 thật: danh sách dispatch (coordinator run, trạng thái từng agent con, message log) — gọi các RPC `orchestration.*` đã có ở backend-go (hiện gần như chỉ có `dispatchShow` theo khảo sát CR-FLOW-TASK-004's bảng so sánh — cần audit thêm RPC nào khác đã tồn tại).
3. Giữ nguyên `terminal-orchestration-task-links.ts` — đây là tiện ích tốt, hữu dụng độc lập với việc có dashboard đầy đủ hay không; nên tái sử dụng cùng RPC (`orchestration.dispatchShow`) làm nền cho dashboard mới thay vì viết lại từ đầu.

## Tham khảo

- Backend liên quan: [BUG-TASKV1-005](../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) (orchestration-service thiếu 5-6/11 RPC theo TDD, không có coordinator loop, bảng messages chết)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-001-three-engine-execution-architecture.md (Engine 2 trong mô hình 3-engine)
- CR liên quan: docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md (bảng so sánh xác nhận `orchestration.*` "gần như trống")
- LƯU Ý KHÔNG NHẦM: `specs/frontend/bugs/agent-orchestration/BUG-FE-ORCH-001-no-ipc-bridge-agent-start-stop-resume.md` nói về Agent Orchestration (vòng đời 1 agent session qua `agent.start/stop/resume`) — KHÁC hoàn toàn với Task Execute/Orchestration-service (coordinator/dispatch/TaskRow) mà bug này mô tả.
