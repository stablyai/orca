# TASK-BE-STORAGE-011: Phân loại lỗi transport vs. lỗi dispatch thật trước khi gọi `FailDispatch`

**Solution:** BE-SOL-STORAGE-003 | **CR:** CR-STORAGE-008(b)
**Service:** `orchestration-service`
**Depends on:** TASK-BE-STORAGE-009 (cần biết trạng thái `connections.status` của connection liên quan)
**Status:** 🟡 PARTIAL — 2026-09-07 (`ClassifyDispatchFailure` DONE trên
tín hiệu thật có sẵn; "sửa caller thật của `FailDispatch`" KHÔNG làm được
vì `FailDispatch` chưa tồn tại trong code — xem điều tra bên dưới)

> **Kết quả thực tế:** Điều tra trước khi code (bắt buộc theo task) phát
> hiện tiền đề của mục "Files cần sửa" #1 sai: **không có caller thật của
> `FailDispatch` để sửa, vì bản thân `FailDispatch` chưa được implement ở
> bất kỳ đâu** trong `orchestration-service` (không proto RPC, không
> usecase, không gRPC handler) — đây là 1 "Known gap" đã tự ghi nhận sẵn
> trong `orchestration-service/README.md`, không phải phát hiện mới bất
> ngờ. `grep -rn "FailDispatch" backend-go/` toàn repo chỉ ra 3 dòng, cả 3
> là comment ở `infra-fleet-service`, không có định nghĩa. `domain.
> ConnectionStatus` mà pseudocode gốc của task giả định cũng không tồn
> tại trong `orchestration-service` (đó là type nội bộ của
> `infra-fleet-service`, không import được — không có gRPC client nào từ
> `orchestration-service` sang `infra-fleet-service`, `grep` 0 kết quả).
> Xác nhận độc lập bằng `gitnexus`:
> `impact({target:"FailDispatch", direction:"upstream"})` →
> `"error": "Target 'FailDispatch' not found"`;
> `impact({target:"RecordFailure", direction:"upstream"})` (method domain
> gần nhất với ngữ nghĩa fail-1-dispatch) → `impactedCount: 0` (không ai
> gọi). Đầy đủ chi tiết điều tra đã append vào
> [BE-SOL-STORAGE-003 §"Investigation result: TASK-BE-STORAGE-011 signal for `ClassifyDispatchFailure`"](../solutions/BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md#investigation-result-task-be-storage-011-signal-for-classifydispatchfailure).
>
> **Theo đúng nhánh dự phòng đã chỉ định trước khi viết code** (không có
> tín hiệu `connections.status` thật, không tự thêm cross-service RPC
> mới): `classify_dispatch_failure.go` (MỚI) implement
> `ClassifyDispatchFailure(err error) FailureOrigin` dựa trên **mã gRPC
> chuẩn, luôn sẵn có** — `codes.Unavailable`/`codes.DeadlineExceeded` (qua
> `status.FromError`) và `context.DeadlineExceeded` (qua `errors.Is`) ⇒
> `FailureOriginTransport`; mọi lỗi khác ⇒ `FailureOriginDispatchReal`.
> Đây KHÔNG phải chữ ký/3 hằng số (`TransportDegraded`/`TransportClosed`/
> `DispatchReal`) trong pseudocode gốc — pseudocode đó giả định
> `domain.ConnectionStatus` đầu vào không hề tồn tại; chữ ký/hằng số thật
> được ghi rõ lý do trong code comment của file.
>
> `classify_dispatch_failure_test.go` (MỚI) — 7 test, tất cả PASS thật
> (`go test ./internal/usecase/... -run TestClassifyDispatchFailure -v`):
> `TestClassifyDispatchFailure_UnavailableReturnsTransport`,
> `TestClassifyDispatchFailure_GRPCDeadlineExceededReturnsTransport`,
> `TestClassifyDispatchFailure_ContextDeadlineExceededReturnsTransport`,
> `TestClassifyDispatchFailure_WrappedContextDeadlineExceededReturnsTransport`,
> `TestClassifyDispatchFailure_GenericErrorReturnsDispatchReal`,
> `TestClassifyDispatchFailure_OtherGRPCStatusReturnsDispatchReal`,
> `TestClassifyDispatchFailure_NilErrorReturnsUnknown`. Đây thay thế 3 test
> tên gốc (`_DegradedReturnsTransportDegraded` v.v. — không viết được vì
> input `connectionStatus` không tồn tại).
>
> **KHÔNG làm** (ngoài khả năng thật của task, không phải bỏ sót):
> - Mục "Files cần sửa" #1 (sửa caller thật của `FailDispatch`) — không
>   có file nào để sửa. Không tự tạo `FailDispatch` usecase/RPC/proto
>   mới hay 1 dispatcher-loop mới để có chỗ gọi — đó là mở rộng phạm vi
>   rất lớn ngoài 3 file được liệt kê, để lại cho 1 task riêng khi
>   `FailDispatch` thật được implement.
> - `TestDispatchedContextNotFailed_WhileConnectionDegraded` và
>   `TestDispatchedContextFailed_WhenConnectionClosedAfterGracePeriod`
>   (2 test "integration-ish" trong "Test cases cần cover") — cả hai cần
>   1 caller thật + 1 fake `ConnectionRepository` được wire vào, không có
>   trong `orchestration-service` hôm nay (đó là port của
>   `infra-fleet-service`). Không viết test giả cho code không tồn tại.
>
> **Verify thật đã chạy:**
> ```
> $ cd backend-go/services/orchestration-service && go build ./... && go test ./...
> ok  	github.com/stablyai/orca-go/services/orchestration-service/internal/domain	0.003s
> ok  	github.com/stablyai/orca-go/services/orchestration-service/internal/usecase	0.093s
> $ gofmt -l .
> (không có output — sạch)
> ```
>
> **Blocking note:** TASK-BE-STORAGE-012's
> `TestDegradedConnectionDoesNotTripCircuitBreaker` phụ thuộc task này —
> vẫn PHỤ THUỘC được vào `ClassifyDispatchFailure` (hàm thuần đã xong,
> test độc lập được như đúng ý "dễ test độc lập với `FailDispatch`" của
> mục tiêu gốc), nhưng bất kỳ phần nào của 012 cần 1 `FailDispatch` caller
> thật đang chạy sẽ tiếp tục bị chặn bởi cùng khoảng trống đã ghi ở đây.

---

## Mục tiêu

Theo đúng bảng phân loại ở BE-SOL-STORAGE-003 §4 — KHÔNG gọi `FailDispatch`
khi lỗi là do connection `degraded` (tạm thời), CHỈ gọi khi `closed` (hết
grace-period) hoặc lỗi dispatch thật sự trong lúc `established`.

## Files cần sửa

1. File caller hiện tại của `FailDispatch` (xác định qua
   `orchestration-service.md` §3/§8 — đọc code thật để tìm đúng file, có
   thể là 1 dispatcher/coordinator loop) — MODIFY, thêm bước phân loại
   trước khi gọi.
2. `backend-go/services/orchestration-service/internal/usecase/classify_dispatch_failure.go` (MỚI) — hàm phân loại thuần, dễ test độc lập với `FailDispatch`.

## Nội dung

```go
type FailureOrigin int
const (
	FailureOriginUnknown FailureOrigin = iota
	FailureOriginTransportDegraded   // connection đang degraded — KHÔNG fail
	FailureOriginTransportClosed     // connection đã closed (hết grace period) — fail thật
	FailureOriginDispatchReal        // lỗi thực thi/timeout trong lúc established — fail thật
)

func ClassifyDispatchFailure(connectionStatus domain.ConnectionStatus, errKind DispatchErrorKind) FailureOrigin {
	switch {
	case connectionStatus == domain.StatusDegraded:
		return FailureOriginTransportDegraded
	case connectionStatus == domain.StatusClosed:
		return FailureOriginTransportClosed
	default: // established
		return FailureOriginDispatchReal
	}
}
```

Caller hiện tại của `FailDispatch`:

```go
origin := ClassifyDispatchFailure(connectionStatus, errKind)
if origin == FailureOriginTransportDegraded {
	return nil   // để nguyên dispatched, không fail — chờ reconnect (TASK-BE-STORAGE-009)
}
return failDispatch.Execute(ctx, dispatchContextID, reason)   // TransportClosed hoặc DispatchReal — fail thật
```

**Không đổi** ngưỡng `failure_count >= 3 -> circuit_broken` — chỉ đổi
input nào được tính là 1 failure (đúng BE-SOL-STORAGE-003 §4's "Không đổi
ngưỡng, chỉ đổi cái gì được tính là 1 failure").

## Test cases cần cover

- `TestClassifyDispatchFailure_DegradedReturnsTransportDegraded`
- `TestClassifyDispatchFailure_ClosedReturnsTransportClosed`
- `TestClassifyDispatchFailure_EstablishedReturnsDispatchReal`
- `TestDispatchedContextNotFailed_WhileConnectionDegraded` (integration-ish,
  dùng fake `ConnectionRepository`)
- `TestDispatchedContextFailed_WhenConnectionClosedAfterGracePeriod`

## Verify

```bash
cd backend-go/services/orchestration-service && go build ./... && go test ./...
```

## gitnexus

`impact({target: "FailDispatch", direction: "upstream"})` — bắt buộc,
`FailDispatch` gần như chắc chắn có nhiều caller khác (mọi loại lỗi dispatch
hiện tại) — xác nhận task này chỉ thêm 1 điều kiện trước khi gọi ở ĐÚNG
call site liên quan tới lỗi transport, không đổi hành vi các caller khác.

## Blocking

TASK-BE-STORAGE-012's `TestDegradedConnectionDoesNotTripCircuitBreaker`
phụ thuộc task này.
