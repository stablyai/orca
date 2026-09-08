# Agent Solutions — Storage Consolidation (CR-STORAGE-00x)

**CRs:** [docs/crs/v3/storage/](../../../../../docs/crs/v3/storage/README.md)
**backend-go counterpart:** [specs/backend-go/crs/v3/storage/solutions/](../../../../backend-go/crs/v3/storage/solutions/README.md)
**Frontend counterpart:** [specs/frontend/crs/v3/storage/solutions/](../../../../frontend/crs/v3/storage/solutions/README.md)

Tất cả 3 solution dưới đây được viết dựa trên
[`specs/agent/tdd/v5/`](../../../../tdd/v5/00-index.md), **đối chiếu lại
với source thật** trong `agent/src/relay/` khi TDD có dấu hiệu lỗi thời —
`00-index.md`'s addendum tự thừa nhận "RPC surface has grown substantially
since" các TDD gốc, và `specs/agent/api/gaps-and-findings.md` xác nhận có
drift. Mọi phát hiện có ghi "verified" trong 3 file dưới đều đã được đọc
trực tiếp từ code hiện tại, không suy đoán từ TDD prose.

## Solutions

| Solution | CR | Phạm vi | Status |
|---|---|---|---|
| [SOL-AG-STORAGE-001](./SOL-AG-STORAGE-001-track1-scope-and-credential-guardrail.md) | CR-STORAGE-001, 002, 003, 004, 005 | Track 1 (tenant-service) — chủ yếu KHÔNG có việc cho agent, trừ 1 ràng buộc bảo mật bắt buộc ở CR-003 | 🔲 Designed |
| [SOL-AG-STORAGE-002](./SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md) | CR-STORAGE-006, CR-STORAGE-007 | Xác nhận tín hiệu handshake/keepalive/token-renewal agent đã gửi đủ cho backend-go hydrate/báo health; phát hiện TDD-AG-03/04 lỗi thời | 🔲 Designed |
| [SOL-AG-STORAGE-003](./SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md) | CR-STORAGE-008 (phần b) | **Trọng tâm** — áp dụng lại pattern daemon+grace-period (đã có, đã đúng cho terminal PTY) sang AI-agent CLI PTY (hiện bị kill ngay khi WS rớt, theo comment `ORCH-011`) | 🔲 Designed |

## Phát hiện quan trọng nhất của cả 3 solution

Khi đối chiếu CR-STORAGE-008(b) ("agent bị ngắt kết nối → kết nối lại vẫn
phải tiếp tục công việc trước đó") với code thật, hoá ra **2 loại PTY
trên agent đang ở 2 trạng thái đối lập nhau**:

- **Terminal PTY** (`pty.create`/xterm) — **đã giải quyết đúng** từ trước,
  qua 1 daemon process tách biệt (`pty-daemon-server.ts`) + grace-period
  120s (`PTY_GRACE_PERIOD_MS`). Không cần làm gì thêm cho loại này.
- **AI-agent CLI PTY** (`agent.spawn` — nơi Claude/Codex/Gemini thực sự
  chạy, tức chính là "công việc" mà CR-STORAGE-008 nói tới) — **bị kill
  NGAY LẬP TỨC** mỗi khi WebSocket rớt, theo 1 quyết định thiết kế tường
  minh (`agent-spawner.ts`'s comment `ORCH-011`: "Kill all PTYs in
  registry when the WS session closes"). Đây là gap thật, không phải suy
  đoán — xem SOL-AG-STORAGE-003.

Nói cách khác: hạ tầng để giải quyết CR-STORAGE-008(b) **đã tồn tại và đã
được chứng minh hoạt động** trong chính codebase này (cho terminal) — việc
cần làm là nhân bản đúng pattern đó sang phần còn thiếu (AI-agent CLI),
không phải thiết kế từ đầu.

## Những gì KHÔNG cần agent-side solution

- **CR-STORAGE-001/002/004/005** — thuần frontend/tenant-service, agent
  không có vai trò gì (xem SOL-AG-STORAGE-001 mục 1).
- **CR-STORAGE-008 phần a** (tách auth-failure khỏi logout ở frontend) —
  không chạm tới agent; agent chỉ cần nhận đúng 1 lệnh teardown tường minh
  khi logout đã xác nhận (xem SOL-AG-STORAGE-003 mục 2 bước 2), việc quyết
  định khi nào gửi lệnh đó là ở frontend/backend-go.

## Thứ tự thực thi & phụ thuộc

```
SOL-AG-STORAGE-001 → độc lập; ràng buộc ở đây (mục CR-003) PHẢI được đối
                      chiếu trước khi BE-SOL-STORAGE-001/FE-SOL-STORAGE-003
                      coi client_settings_json "sẵn sàng đồng bộ toàn bộ"

SOL-AG-STORAGE-002 → độc lập; chỉ xác nhận tín hiệu đã có, không tạo phụ
                      thuộc build nào. Nên đọc trước SOL-AG-STORAGE-003 vì
                      nó xác nhận tầng transport/reconnect đã ổn định
                      (tiền đề để tầng PTY/work resume phía trên có ý nghĩa)

SOL-AG-STORAGE-003 → phụ thuộc SOL-AG-STORAGE-002 (cần transport-level
                      reconnect đã đáng tin cậy) và nên làm song song/sau
                      BE-SOL-STORAGE-003 (backend-go's grace_period_seconds
                      cần khớp với agent's PTY_GRACE_PERIOD_MS, xem mục 2
                      bước 3 của SOL-AG-STORAGE-003)
```

## Rủi ro chung cần lưu ý

- **`desktop/src/relay/`** có 1 bản sao gần như trùng khớp của nhiều file
  `agent/src/relay/` (`agent-spawner.ts`, `pty-agent-bridge.ts`,
  `pty-daemon-server.ts` — xác nhận qua đọc source). Bất kỳ thay đổi nào ở
  SOL-AG-STORAGE-003 cần xác nhận có phải đồng bộ sang `desktop/` hay
  `desktop/` đã ngừng là target build thật — không giả định, xem
  SOL-AG-STORAGE-003 mục 3.
- **TDD-AG (`specs/agent/tdd/v4`, `v5`) đã lỗi thời ở 1 số phần** (xác
  nhận cụ thể: mô tả reconnect ở TDD-AG-03/04 sai so với code thật hiện
  tại — xem SOL-AG-STORAGE-002 mục 2). Không dùng các TDD này làm nguồn
  sự thật duy nhất khi implement — luôn đối chiếu `agent/src/relay/`
  hiện tại và `specs/agent/api/` (catalog code-verified, có
  `gaps-and-findings.md` riêng).
