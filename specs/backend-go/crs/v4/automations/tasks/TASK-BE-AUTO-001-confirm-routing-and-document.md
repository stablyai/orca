# TASK-BE-AUTO-001: Verify `workflow-service` không chặn remote target + ghi kiến trúc 2 trục

**Solution:** [BE-AUTO-SOL-001](../solutions/BE-AUTO-SOL-001-confirm-routing-close-gaps.md) | **CR:** CR-AUTO-001
**Depends on:** Không
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Xác nhận (không giả định) rằng `workflow-service`'s dispatch target
resolution không có giới hạn kiểu Electron-local's
`run-target-resolution.ts:41-50`, và ghi lại kiến trúc 2 trục
(deployment target × pairing) đã xác nhận vào
`automation-service/README.md` để lần audit sau không lặp lại kết luận
sai "3 bản triplicate, backend-go không ai dùng".

## Files cần sửa

1. `backend-go/services/automation-service/README.md` (MODIFY — thêm mục "Quan hệ với automation TS (Electron/Node)")
2. Không sửa code nếu bước xác nhận cho kết quả đúng như kỳ vọng — chỉ ghi tài liệu.

## Bước 1 — Đọc `relay_client.go`

Đọc `backend-go/services/workflow-service/internal/adapter/infrafleetclient/relay_client.go`
xác nhận: dispatch tới target nào (dev server nào) hoàn toàn do
`ConnectionID` trong step config quyết định, không có logic nào phân
biệt "target này là remote, automation không được phép chạy" như phía
Electron có. Nếu phát hiện 1 giới hạn tương tự tồn tại — ghi lại thành
phát hiện mới, KHÔNG tự sửa trong task này (báo cáo, tạo task theo dõi
riêng).

## Bước 2 — Ghi vào README

Thêm mục mới, nội dung tối thiểu:
- 2 trục: deployment target (Electron desktop vs Node server-mode, loại
  trừ lẫn nhau) × pairing (`{kind:'local'}` vs `{kind:'environment'}`,
  áp dụng như nhau bất kể trục 1).
- `automation-service` phục vụ mọi automation ở pairing-path
  (`{kind:'environment'}`), bất kể client là Electron desktop hay
  server-mode.
- Trỏ sang `docs/crs/v4/automations/CR-AUTO-001-consolidate-execution-backend.md`'s
  "Cập nhật 2026-09-09" để biết đầy đủ evidence.

## Verify

Không có test code — verify bằng review (đọc lại `relay_client.go` +
README mới, xác nhận không tuyên bố gì không có bằng chứng).

## Kết quả cần ghi lại (khi hoàn thành)

- Xác nhận rõ: `relay_client.go` có/không có giới hạn remote — trích
  dẫn dòng cụ thể.

---

## ✅ Kết quả thực tế (2026-09-09)

`relay_client.go`'s `relay()` (dòng 39-70) forward thẳng tới
`infra-fleet-service`'s `Relay` RPC bằng `connectionID` lấy từ step
config — không có branch nào phân biệt local/remote, không giới hạn
kiểu `run-target-resolution.ts:41-50` phía Electron. Xác nhận đúng như
kỳ vọng, không phát hiện giới hạn nào cần báo cáo thêm.

Thêm mục "Quan hệ với automation TS (Electron/Node) — không phải 3 bản
triplicate" vào `automation-service/README.md` (chèn trước "## Running
locally"), viết bằng tiếng Anh khớp ngôn ngữ hiện có của README này.

**Files đã sửa:**
- `backend-go/services/automation-service/README.md` (MODIFY)
