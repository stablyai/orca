# BACKLOG-019: `StreamExecOutput` (agent output streaming) gate theo `relay-ssh` giống `StreamPty` — nhưng doc comment của `StreamPty` tự mâu thuẫn về việc này

**Origin:** Phát hiện trong lúc thực thi `TASK-AG-FLOWTASK-002` (2026-09-08), agent tự flag lại đúng mâu thuẫn mà `SOL-AG-FLOWTASK-001` đã nêu nhưng chưa giải quyết
**Priority:** Low — không chặn chức năng chính (direct-websocket/relay-websocket mode hoạt động đầy đủ), chỉ ảnh hưởng dev server dùng SSH-relay
**Blocked on:** Cần đọc lại toàn bộ lịch sử thiết kế `client.go`'s `StreamPty` để xác định ý định thật (tài liệu tự mâu thuẫn, không phải code sai)

---

## Hiện trạng

`infra-fleet-service`'s `client.go` có `StreamPty` với doc comment tự mâu thuẫn về việc RPC streaming này có hoạt động qua `relay-ssh` connection mode hay không. `TASK-AG-FLOWTASK-002` (agent output streaming mới, `StreamExecOutput`) đã **cố tình gate giống hệt `StreamPty`** (theo đúng "default stance" đã ghi trong task) thay vì tự quyết định khác — nghĩa là bug/mâu thuẫn tài liệu này (nếu có) sẽ lặp lại ở `StreamExecOutput`.

## Việc cần làm khi triển khai

1. Đọc lại lịch sử git/PR của `StreamPty`'s doc comment để xác định ý định gốc — SSH-relay dev server có được hỗ trợ streaming loại này hay không, và tại sao doc comment lại mâu thuẫn.
2. Sau khi rõ, áp dụng thống nhất cho cả `StreamPty` và `StreamExecOutput` (đã cố tình đồng bộ 2 cái này với nhau, chỉ cần sửa 1 chỗ).

## Tham khảo
- `specs/agent/crs/v3/flow-task/solutions/SOL-AG-FLOWTASK-001-execution-activity-streaming-design.md` (mục "phân tích 3 connection mode", nơi mâu thuẫn được ghi nhận lần đầu)
- `specs/agent/crs/v3/flow-task/tasks/TASK-AG-FLOWTASK-002-infra-fleet-execoutput-demux.md`
