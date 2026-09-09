# TASK-BE-AUTO-006: `create_pr` dispatch branch + `scm-integration-service` client

**Solution:** [BE-AUTO-SOL-003](../solutions/BE-AUTO-SOL-003-action-executors-commit-pr.md) | **CR:** CR-AUTO-003
**Depends on:** [TASK-BE-AUTO-004](./TASK-BE-AUTO-004-execute-automation-chain-usecase.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

`create_pr` action gọi thẳng `scm-integration-service`'s
`createPullRequest`, không qua `workflow-service`/agent (khác
`commit_push`).

## Files cần sửa

1. `backend-go/services/automation-service/internal/adapter/grpcclient/scm_client.go` (MỚI, NẾU chưa tồn tại — xem bước 1)
2. `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY — case `CREATE_PR`)
3. Test tương ứng

## Bước 1 — Xác nhận có client sẵn chưa

Kiểm tra `backend-go/services/automation-service/internal/adapter/grpcclient/`
đã có client tới `scm-integration-service` chưa (chỉ có
`workflow_client.go` theo audit trước — xác nhận lại). Nếu chưa, thêm
mới theo đúng khuôn `workflow_client.go`.

## Nội dung

```go
case AUTOMATION_ACTION_TYPE_CREATE_PR:
    var cfg createPrParams // {title, body, base, draft}
    json.Unmarshal([]byte(action.ConfigJson), &cfg)
    resp, err := e.scmClient.CreatePullRequest(ctx, &scmv1.CreatePullRequestRequest{
        Title: cfg.Title, Body: cfg.Body, Base: cfg.Base, Draft: cfg.Draft,
        // repo/branch: từ automation's context — xác nhận nguồn đúng (runContext hay action config) trước khi code
    })
```

`draft` field: default `true` theo CR-AUTO-003's khuyến nghị giảm rủi ro
spam PR — xác nhận `CreatePullRequestRequest` có field `Draft` sẵn có
chưa, nếu chưa cần thêm vào `scm-integration-service`'s proto (ngoài
scope task này nếu vậy — báo cáo, không tự mở rộng service khác).

## Test cases cần cover

- `create_pr` action gọi đúng `CreatePullRequest` với field map đúng.
- Thiếu `title` → lỗi validate trước khi gọi gRPC.
- gRPC lỗi → propagate đúng, không nuốt lỗi.

## Verify

```bash
cd backend-go/services/automation-service && go test ./internal/usecase/... ./internal/adapter/grpcclient/...
```

## gitnexus

`impact({target: "CreatePullRequest", direction: "upstream"})` trước khi
thêm caller mới — xác nhận không phá contract hiện có (renderer's
`pull-request-generation.ts` là caller khác của cùng RPC, không được
ảnh hưởng).

---

## ✅ Kết quả thực tế (2026-09-09)

**Bước 1** xác nhận đúng: `automation-service` chưa có client nào tới
`scm-integration-service` — chỉ có `workflow_client.go`. Đã thêm
`scm_client.go` mới theo đúng khuôn `WorkflowClient` (dial 1 lần ở
`cmd/server/main.go`, port hẹp qua `usecase.PullRequestCreator`).

**Phát hiện quan trọng, lệch so với sketch gốc**: `CreatePullRequestRequest`
proto (`scmintegration.proto:149-157`) **không có field `draft`** — tính
năng "Draft PR mặc định" mà CR-AUTO-003 khuyến nghị **không khả thi** ở
layer này mà không sửa proto của `scm-integration-service` (service
khác, blast radius lớn hơn, ngoài phạm vi CR-AUTO-003). Ghi nhận là gap
đã biết, không tự ý mở rộng sang service khác.

**Quyết định thiết kế chưa có trong CR/task gốc**: `create_pr` action's
`config_json` phải tự mang `provider`/`repo`/`headBranch`/`baseBranch`
tường minh — vì `automation-service`'s domain model **không có khái
niệm** "automation này thuộc project/workspace nào" (khác hẳn TS side có
`projectId`/`workspaceId`/`sourceContext`). Đây không phải thiếu sót của
task này mà là giới hạn thật của domain model hiện tại — ghi rõ trong
`CreatePullRequestInput`'s doc comment để không ai hiểu nhầm là thiếu
sót có thể tự sửa nhanh.

**Không wire `NewExecuteAutomationChain(...)` vào `cmd/server/main.go`**
— nhất quán với quyết định của TASK-BE-AUTO-004 (không rewire `RunNow`).
`cfg.ScmIntegrationServiceAddr` + `grpcclient.NewScmClient` đã sẵn sàng,
chỉ cần 1 khối wiring nhỏ khi tới lúc rewire.

**Verify**: `go build`/`go vet` cho `automation-service` — sạch. `go test`
— toàn bộ package pass, gồm 4 test mới cho `ScmClient` (forward tenant
qua outgoing metadata — cùng class regression `WorkflowClient` đã từng
gặp; thiếu tenant context → không gọi client; lỗi transport propagate;
`toProtoScmProvider` chấp nhận cả tên ngắn lowercase lẫn tên enum đầy
đủ) và 3 test mới cho `ExecuteAutomationChain`'s `CREATE_PR`/`COMMIT_PUSH`
dispatch (đã sửa lại `COMMIT_PUSH` từ "not implemented" — sót lại từ
TASK-BE-AUTO-004 trước khi 005 xong — thành dispatch thật qua
`dispatchViaWorkflow`).

**Files đã sửa/tạo:**
- `backend-go/services/automation-service/internal/usecase/ports.go` (MODIFY — `PullRequestCreator` port)
- `backend-go/services/automation-service/internal/adapter/grpcclient/scm_client.go` (MỚI)
- `backend-go/services/automation-service/internal/adapter/grpcclient/scm_client_test.go` (MỚI)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY — `dispatchCreatePR`, sửa `COMMIT_PUSH`)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain_test.go` (MODIFY)
- `backend-go/services/automation-service/internal/config/config.go` (MODIFY — `ScmIntegrationServiceAddr`)
- `backend-go/services/automation-service/cmd/server/main.go` (MODIFY — comment ghi lại điểm wiring còn lại)
