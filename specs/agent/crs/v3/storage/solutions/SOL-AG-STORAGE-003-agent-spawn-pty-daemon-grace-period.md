# SOL-AG-STORAGE-003: Áp dụng lại pattern daemon+grace-period (đã có cho terminal PTY) cho AI-agent CLI PTY (CR-STORAGE-008 phần b)

> **🔲 Designed — chưa implement.** Đây là phát hiện cốt lõi của cả bộ
> solution track 2 phía agent: **terminal PTY đã được giải quyết đúng
> yêu cầu "reconnect thì tiếp tục việc cũ" từ trước** (qua
> `pty-daemon-server.ts`, một tiến trình tách biệt), nhưng **AI-agent CLI
> PTY (nơi Claude/Codex/Gemini thực sự chạy) thì KHÔNG** — nó vẫn bị kill
> ngay lập tức mỗi khi WebSocket rớt, theo đúng 1 comment thiết kế tường
> minh (`ORCH-011`) đối lập trực tiếp với yêu cầu của CR-STORAGE-008(b).
> Solution này đề xuất áp dụng lại chính xác pattern đã chứng minh hoạt
> động cho terminal PTY, không phát minh cơ chế mới.

**CR:** [CR-STORAGE-008](../../../../../../docs/crs/v3/storage/CR-STORAGE-008-reconnect-resume-semantics.md) (phần b)
**backend-go counterpart:** [BE-SOL-STORAGE-003](../../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md)
**Frontend counterpart:** [FE-SOL-STORAGE-007](../../../../../frontend/crs/v3/storage/solutions/FE-SOL-STORAGE-007-reconnect-preserves-session-state.md)
**TDD tham chiếu:** `specs/agent/tdd/v5/12-agent-spawner.md` (lưu ý: đã lỗi thời ở phần lifecycle, xem mục 1)

---

## 1. Hiện trạng — verified bằng đọc source thật, KHÔNG phải TDD

### (a) Terminal PTY (`pty.create`/`pty.write`/...) — ĐÃ đúng yêu cầu resume

`agent/src/relay/pty-daemon-server.ts` (module header comment, đọc nguyên
văn):

> "pty-agent-bridge.ts's PTYs used to live in the agent's own process
> memory, so an agent restart (deploy, systemd restart, crash) killed
> every terminal outright. This daemon is a separate OS process —
> spawned detached from the agent, NOT part of its process group — that
> holds the real node-pty instances instead. The agent becomes a thin
> client (pty-daemon-client.ts) that reconnects to this already-running
> daemon after a restart, so terminals survive exactly like an SSH
> relay's PTYs survive an SSH channel drop."

Cơ chế thật:

1. `node-pty` instance thật sống trong **daemon process riêng**
   (`runPtyDaemon()`), không nằm trong agent process kết nối WS tới Orca.
2. Khi WS agent↔Orca rớt, agent (client của daemon) gọi
   `notifyDaemonSessionClosed()` → daemon nhận `daemon.sessionClosed` →
   `scheduleGracePeriodCleanup(log)` — set 1 timer `PTY_GRACE_PERIOD_MS =
   120_000` (120s) cho **từng** PTY đang có.
3. Nếu agent reconnect (WS mới, `pty.attach` lại đúng `ptyId`) trong vòng
   120s → grace timer bị huỷ, PTY tiếp tục sống, output tiếp tục stream —
   **đúng yêu cầu "reconnect thì tiếp tục việc cũ"**.
4. Nếu hết 120s không reattach → PTY bị `kill('SIGTERM')` thật.
5. Giá trị 120s được chọn có chủ đích, theo code comment: "Sized to
   comfortably cover a full agent PROCESS restart (systemd
   RestartSec=15 + node startup + token fetch/retry + WS reconnect), not
   just a brief network blip."
6. `cleanupAgentPtys()` (kill NGAY, không chờ) chỉ chạy khi **chính
   daemon** nhận `SIGTERM`/`SIGINT` (daemon tự tắt) — không chạy khi agent
   process (WS client) đóng/khởi động lại.

### (b) AI-agent CLI PTY (`agent.spawn`/`agent.kill`, nơi Claude/Codex/Gemini thực sự chạy) — CHƯA đúng yêu cầu

`agent/src/relay/agent-spawner.ts` (đọc nguyên văn code comment ngay trên
hàm `cleanupAllPtys`):

```typescript
// ORCH-011: Kill all PTYs in registry when the WS session closes.
// Prevents orphaned agent processes consuming resources on the Dev Server.

export function cleanupAllPtys(log: AgentLogger): void {
  if (PTY_REGISTRY.size === 0) {return}
  log.info(`session.stop: cleaning up ${PTY_REGISTRY.size} orphaned PTY(s)`)
  for (const [ptyId, entry] of PTY_REGISTRY.entries()) {
    try {
      if (process.platform === 'win32') { entry.pty.kill() }
      else { entry.pty.kill('SIGTERM') }
    } catch (err) { log.warn(...) }
  }
  PTY_REGISTRY.clear()
}
```

`PTY_REGISTRY` ở đây sống **trong chính process agent kết nối WS** (không
có daemon tách biệt như (a)), và `cleanupAllPtys(log)` được gọi từ
`agent-session.ts`'s `stop()` **mỗi khi WS đóng** — kể cả khi đó chỉ là 1
network blip mà `connectDirect()` sẽ tự reconnect lại trong 1 giây
(`RECONNECT_DELAYS_MS[0] = 1000`, xem
[SOL-AG-STORAGE-002](./SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md)
mục 2). **Kết quả thực tế hôm nay: 1 lần mất mạng 1 giây giữa agent và
Orca giết chết ngay lập tức mọi phiên Claude/Codex/Gemini đang chạy trên
dev server đó** — đây chính xác là hành vi CR-STORAGE-008(b) yêu cầu sửa
("nếu agent bị ngắt kết nối → kết nối lại vẫn phải tiếp tục công việc
trước đó"), và nó bị gây ra bởi 1 quyết định thiết kế **tường minh, có
chủ đích** (`ORCH-011`), không phải một lỗi ẩn.

## 2. Giải pháp đề xuất — nhân bản pattern (a) sang (b), không phát minh mới

### Bước 1 — Tách `PTY_REGISTRY` (agent-spawner.ts) ra khỏi process agent, theo đúng mẫu `pty-daemon-server.ts`

```
agent/src/relay/
├── agent-spawn-daemon-server.ts   (MỚI — nhân bản pty-daemon-server.ts)
│     runAgentSpawnDaemon(socketPath, log)
│     - Giữ PTY_REGISTRY thật (SubAgentSpawner's node-pty instances)
│     - dispatchDaemonRequest: 'agent.spawn' | 'agent.kill' | 'agent.sendInput'
│       | 'daemon.ping' | 'daemon.sessionClosed'
│     - scheduleGracePeriodCleanup(log, graceTimeMs) — TÁI DÙNG nguyên hàm
│       đã có ở pty-agent-bridge.ts nếu có thể tổng quát hoá qua 1 map
│       chung {ptyId -> {pty, graceTimer}}, hoặc nhân bản 1:1 nếu 2 loại
│       PTY cần vòng đời khác nhau đủ để không dùng chung được — QUYẾT
│       ĐỊNH CỤ THỂ cần 1 lượt đọc kỹ cả 2 module trước khi implement
│       (không giả định trước là dùng chung được ngay)
├── agent-spawn-daemon-client.ts   (MỚI — nhân bản pty-daemon-client.ts)
│     Agent process (WS client) gọi qua Unix socket, y hệt cách
│     pty-agent-bridge.ts's handler hiện tại gọi pty-daemon-client.ts
└── agent-spawner.ts               (MODIFY)
      - handleAgentSpawn/handleAgentKill: forward qua
        agent-spawn-daemon-client thay vì thao tác PTY_REGISTRY trực tiếp
        trong process — GIỮ NGUYÊN chữ ký RPC (agent.spawn/agent.kill),
        chỉ đổi nơi PTY thật sự sống
      - cleanupAllPtys(log): đổi từ kill NGAY LẬP TỨC sang gọi
        notifyAgentSpawnDaemonSessionClosed() (arm grace period), ĐÚNG
        như agent-session.ts đã làm cho pty-agent-bridge hôm nay
```

### Bước 2 — `agent-session.ts`'s `stop()` — phân biệt rõ 2 nhánh cleanup, không gộp chung nữa

```typescript
// agent-session.ts — stop(), MODIFY
stop(): void {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null }

  // TRƯỚC: cleanupAllPtys(log) — kill NGAY, không phân biệt lý do đóng WS
  // SAU: chỉ arm grace period, y hệt cleanupAgentPtys/cleanupAgentWatches
  // đã làm cho terminal PTY/fs.watch — việc kill thật (nếu cần) chuyển
  // sang phía daemon riêng, sau khi hết PTY_GRACE_PERIOD_MS không reattach.
  void notifyAgentSpawnDaemonSessionClosed(log)   // MỚI, thay cleanupAllPtys(log)
  void notifyDaemonSessionClosed(log)             // KHÔNG ĐỔI — terminal PTY, đã đúng
  cleanupAgentWatches()                           // KHÔNG ĐỔI — fs.watch, phạm vi khác
}
```

**Đóng chủ động (logout đã xác nhận, CR-STORAGE-008 phần a)** vẫn cần 1
đường kill NGAY, không chờ grace-period — mirror đúng thiết kế (a): daemon
chỉ kill ngay khi **chính nó** nhận `SIGTERM` trực tiếp, hoặc khi nhận 1
lệnh tường minh riêng (không phải `daemon.sessionClosed`, mà 1 method mới,
ví dụ `daemon.sessionTeardown`) — được agent gọi khi backend-go gửi lệnh
đóng chủ động (mirror `TeardownConnection` phía BE-SOL-STORAGE-003 mục 5).
**Không tái dùng `daemon.sessionClosed` cho cả 2 trường hợp** — nếu không
sẽ mất khả năng phân biệt "network blip" và "người dùng chủ động logout",
đúng vấn đề CR-STORAGE-008 đang giải quyết ở tầng frontend/backend-go.

### Bước 3 — Khớp giá trị grace-period với backend-go (BE-SOL-STORAGE-003)

`PTY_GRACE_PERIOD_MS = 120_000` (terminal PTY, đã có, đã tuning cho đúng
kịch bản "agent process restart") là 1 điểm neo tốt — đề xuất **dùng lại
đúng giá trị này** cho AI-agent CLI PTY thay vì bịa 1 con số khác, trừ khi
review riêng chỉ ra AI-agent CLI cần cửa sổ khác (ví dụ dài hơn vì spawn
lại 1 phiên Claude tốn kém hơn spawn lại 1 shell). Đối chiếu với
`grace_period_seconds` đề xuất ở BE-SOL-STORAGE-003 (300s mặc định, cho
`connections.status: degraded`) — 2 con số này **không nhất thiết phải
bằng nhau** (1 cái là "PTY tồn tại bao lâu trên dev server", 1 cái là
"backend-go coi connectionId còn hợp lệ bao lâu") nhưng cửa sổ agent-local
(120s) nên **≤** cửa sổ backend-go (300s) — nếu ngược lại, backend-go vẫn
nghĩ connection "degraded" (còn cơ hội) trong khi PTY thật trên dev server
đã bị kill, gây lệch trạng thái. Cần xác nhận/đồng bộ 2 giá trị này khi
implement cả 2 phía.

## 3. Rủi ro / Phức tạp cần lường trước — không giả định trước là dễ

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| OSC sequence parsing state machine (`idle → running → waiting_for_input → completed`, theo `00-index.md` §A.6) hiện chạy **trong process agent**, không phải trong daemon | **Cao** | Nếu state machine này cần thấy MỌI byte output để hoạt động đúng, tách PTY ra daemon riêng (không có state machine đó) sẽ làm mất khả năng phát hiện trạng thái trong lúc agent process đang restart/reconnect — cần thiết kế: hoặc (a) chuyển state machine vào daemon cùng PTY, hoặc (b) daemon chỉ buffer raw output, agent re-derive state machine từ buffer sau khi reattach — **chưa quyết định, cần 1 phiên thiết kế riêng đọc kỹ `agent-spawner.ts`'s state-machine code trước khi chọn** |
| 2 module daemon riêng (`pty-daemon-*`, `agent-spawn-daemon-*`) hay gộp chung 1 daemon | Trung bình | Chạy 2 tiến trình daemon riêng là an toàn hơn (lỗi 1 bên không ảnh hưởng bên kia) nhưng tốn thêm 1 Unix socket + 1 idle-shutdown timer; gộp chung tiết kiệm hơn nhưng tăng blast radius nếu daemon crash. Cần quyết định khi implement, không mặc định |
| `desktop/src/relay/agent-spawner.ts` là bản sao gần như y hệt `agent/src/relay/agent-spawner.ts` | Trung bình | Xác nhận đọc source: 2 file gần như trùng khớp dòng-với-dòng (`ORCH-011` comment, `cleanupAllPtys` giống hệt). Bất kỳ thay đổi nào ở bước 1/2 cần áp dụng đồng bộ cả 2 nơi, hoặc xác nhận `desktop/` không còn là target build thật (nếu đã bị thay thế hoàn toàn bởi `agent/`) trước khi bỏ qua — không giả định |
| Chi phí "spawn lại 1 phiên AI agent" cao hơn nhiều so với 1 terminal shell (model context, phiên làm việc dở dang) | Cao về mặt sản phẩm | Đây chính là lý do CR-STORAGE-008(b) tồn tại — nhưng cũng có nghĩa nếu grace-period hết hạn, mất mát thực tế lớn hơn hẳn so với mất 1 terminal. Cân nhắc grace-period dài hơn cho `agent.spawn` PTY so với `pty.create` PTY (xem mục 2 bước 3) là hợp lý, không bắt buộc phải bằng nhau |
| Token/handshake reconnect (SOL-AG-STORAGE-002) đã tự động, nhưng `agent-spawn-daemon-client`'s `pty.attach`-tương-đương cho AI-agent PTY cần được agent tự động gọi lại **ngay sau khi handshake OK** | Trung bình | Không có ai ở phía frontend biết để chủ động gọi "attach lại session AI-agent cũ" — agent cần tự phát hiện (qua daemon) có PTY nào đang chờ reattach và tự khôi phục binding `ptyId ↔ taskId/userId` khi reconnect, tương tự cách `pty.attach` hoạt động cho terminal nhưng có thể cần chủ động hơn (agent-initiated, không đợi frontend request) |

## 4. Checklist

- [x] Xác nhận `pty-daemon-server.ts`/`pty-agent-bridge.ts` đã giải quyết đúng bài toán resume cho terminal PTY (đọc source thật).
- [x] Xác nhận `agent-spawner.ts`'s `cleanupAllPtys`/`ORCH-011` là gap thật, không phải giả định (đọc source thật, cả `agent/` lẫn `desktop/`).
- [x] Đối chiếu giá trị `PTY_GRACE_PERIOD_MS=120_000` với đề xuất `grace_period_seconds=300` ở BE-SOL-STORAGE-003, ghi nhận cần đồng bộ.
- [ ] Thiết kế chi tiết wire protocol giữa `agent-spawn-daemon-client`/`-server` — CHƯA làm, chỉ phác thảo cấu trúc file ở mục 2.
- [ ] Quyết định OSC state-machine sống ở đâu sau khi tách daemon (mục 3, dòng 1) — CHƯA quyết định.
- [ ] Bất kỳ code nào — CHƯA viết.

## Không thuộc phạm vi solution này

- Đóng chủ động khi logout (CR-STORAGE-008 phần a) ở phía frontend/backend-go
  — xem FE-SOL-STORAGE-007/BE-SOL-STORAGE-003; solution này chỉ định nghĩa
  agent nhận lệnh đó qua `daemon.sessionTeardown` (mục 2 bước 2).
- Cập nhật lại `specs/agent/tdd/v5/03-04` cho khớp code thật (SOL-AG-STORAGE-002 mục 2) — tech-debt tài liệu riêng.
- Health/hydration reporting — xem
  [SOL-AG-STORAGE-002](./SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md).

## Liên quan

- `agent/src/relay/pty-daemon-server.ts`, `pty-daemon-client.ts`, `pty-agent-bridge.ts` (mẫu đã chứng minh hoạt động)
- `agent/src/relay/agent-spawner.ts` (`PTY_REGISTRY`, `cleanupAllPtys`, comment `ORCH-011`)
- `desktop/src/relay/agent-spawner.ts` (bản sao cần đồng bộ, xem mục 3)
- `agent/src/relay/agent-session.ts` (`stop()`)
- `specs/agent/tdd/v5/12-agent-spawner.md`, `00-index.md` §A.6 (OSC state machine)
- [BE-SOL-STORAGE-003](../../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md)
- [SOL-AG-STORAGE-002](./SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md)


## 3a. Quyết định thiết kế đã chốt (TASK-AG-STORAGE-005, 2026-09-07)

Cả 3 câu hỏi mở ở §3 đã được trả lời bằng cách đọc source thật — 2 trong 3
hoá ra đơn giản hơn dự kiến ban đầu:

1. **OSC state machine (idle→running→waiting_for_input→completed)**:
   **không tồn tại trong code thật** — chỉ là mô tả trong
   `specs/agent/tdd/v5/00-index.md` §A.6, chưa từng được implement theo
   hướng đó. Cái thật sự tồn tại là `agent-spawner.ts`'s `SubAgentSpawner`
   — 1 enum đơn giản (`idle|spawning|running|stopping|stopped|error`)
   chuyển trạng thái tường minh qua `transition()`, KHÔNG phụ thuộc việc
   đọc từng byte output. **Không có vấn đề "di dời state machine"** — state
   này chuyển vào daemon dễ dàng cùng `PTY_REGISTRY`.
2. **1 daemon chung hay 2 daemon riêng**: `pty-daemon-protocol.ts` đã hoàn
   toàn generic (dispatch theo `method` string, không có gì đặc thù PTY ở
   tầng protocol) — **chọn mở rộng `pty-daemon-server.ts` hiện có**, không
   tạo daemon thứ 2. Đơn giản hoá đáng kể mục 2 bước 1 ở trên — không cần
   `agent-spawn-daemon-protocol.ts`/`-server.ts`/`-client.ts` mới, chỉ cần
   thêm `case` mới vào `dispatchDaemonRequest()` của
   `pty-daemon-server.ts`/`pty-daemon-client.ts` đã có.
3. **`desktop/src/relay/` còn là build target sống không**: **Không** —
   root `package.json`'s `build:agent` script trỏ thẳng `agent/build.mjs`;
   commit tách package (`5edb9a739`, 2026-09-04) tự mô tả `agent/` là
   "split from desktop/"; `desktop/src/relay/agent-spawner.ts` lần sửa
   cuối là 1 commit chung chung trước ngày tách package. Kết luận: bỏ qua
   đồng bộ `desktop/` (xem TASK-AG-STORAGE-009).

**Hệ quả**: mục 2 (Giải pháp đề xuất) ở dưới, phần "Bước 1" mô tả tạo 3
file `agent-spawn-daemon-*.ts` mới — theo quyết định 2 ở trên, bước này
đổi thành "thêm case mới vào `pty-daemon-server.ts`/`pty-daemon-client.ts`
đã có", không tạo file/daemon mới. Xem TASK-AG-STORAGE-006 cho kế hoạch
implementation đã cập nhật.
