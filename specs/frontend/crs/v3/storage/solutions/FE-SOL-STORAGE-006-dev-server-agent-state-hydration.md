# FE-SOL-STORAGE-006: Hydrate dev-server/agent-session state từ backend-go + hiển thị connectivity status

> **🔲 Designed — chưa implement.** Phụ thuộc
> [BE-SOL-STORAGE-002](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md)
> (read-path đã xác nhận + `connectivity.getSummary`/`agentSession.listActive`).

**CRs:** [CR-STORAGE-006](../../../../../../docs/crs/v3/storage/CR-STORAGE-006-centralize-dev-server-agent-state-backend-go.md) · [CR-STORAGE-007](../../../../../../docs/crs/v3/storage/CR-STORAGE-007-bidirectional-error-health-reporting.md)
**TDD tham chiếu:** [`specs/frontend/storage/dev-server-agent-impact.md`](../../../../storage/dev-server-agent-impact.md)

---

## 1. `dev-servers.ts` — hydrate khi mount, không chỉ chờ "populated externally"

```ts
// frontend/src/renderer/src/store/slices/dev-servers.ts — MODIFY, thêm action mới
async function hydrateDevServers(target: RuntimeTarget) {
  set({ devServersSyncState: 'pending' })
  try {
    const list = await callRuntimeRpc(target, 'devServer.listForUser', {})
    set({ devServers: list, devServersSyncState: 'synced' })
  } catch (err) {
    set({ devServersSyncState: 'error' })
    persistenceStatus.setError('devServers', err)   // MỚI — xem FE-002's persistence-status.ts, mở rộng theo CR-007
  }
}
```

Gọi `hydrateDevServers()` ở: (a) App startup, (b) sau khi
`getActiveRuntimeTarget()` đổi, (c) sau khi reconnect thành công (xem
FE-SOL-STORAGE-007). Namespace RPC `devServer.listForUser` **đã tồn tại**
(xác nhận qua `BUG-013`) — solution này không thêm RPC mới cho phần này,
chỉ thêm bước gọi lại khi mount.

## 2. `remote-agent-sessions.ts` — hydrate từ `agentSession.listActive`

```ts
// frontend/src/renderer/src/store/slices/remote-agent-sessions.ts — MODIFY
async function hydrateRemoteAgentSessions(target: RuntimeTarget) {
  const active = await callRuntimeRpc(target, 'agentSession.listActive', {})
  // Map DispatchContext[] -> RemoteAgentSession[] hiện có trong slice's shape.
  // KHÔNG thay thế cơ chế nghe agentOrchestration IPC hiện tại — đây là
  // nguồn hydrate KHỞI ĐẦU (mount/reconnect); sự kiện IPC tiếp tục cập
  // nhật live sau đó như hôm nay.
  set({ remoteAgentSessions: mapDispatchContextsToSessions(active) })
}
```

**Quan trọng**: đây là điểm khác biệt so với việc "thay thế toàn bộ cơ chế
sống bằng RPC" — IPC event vẫn là nguồn cập nhật real-time chính (không đổi
theo nguyên tắc "không transport push mới" của cả nhóm CR); RPC hydrate chỉ
lấp khoảng trống "session nào đang chạy trước khi tôi mở/refresh trang
này".

## 3. `bootstrap.ts` — đọc lại `bootstrap_status` khi mount

```ts
// frontend/src/renderer/src/store/slices/bootstrap.ts — MODIFY
async function resumeBootstrapProgressIfAny(devServerId: string, target: RuntimeTarget) {
  const devServer = await callRuntimeRpc(target, 'devServer.get', { id: devServerId })
  if (devServer.bootstrapStatus && devServer.bootstrapStatus !== 'idle') {
    set({ bootstrapStage: devServer.bootstrapStatus })   // hiển thị đúng bước đang dừng, không reset về đầu
  }
}
```

## 4. `ssh.ts`/`provisioning.ts`/`runtime-environment-ssh.ts` — cùng pattern hydrate

Không lặp lại chi tiết — cùng khuôn "gọi RPC đọc đã có khi mount, set vào
reducer, không đổi cơ chế cập nhật live hiện tại".

## 5. `connectivity-status.ts` — slice mới, dùng cho CR-STORAGE-007

```ts
// frontend/src/renderer/src/store/slices/connectivity-status.ts (MỚI)
interface ConnectivitySlice {
  connections: Record<string, { status: 'establishing'|'established'|'degraded'|'closed'; lastActivityAt?: number; degradedSince?: number }>
  pollConnectivitySummary: (target: RuntimeTarget) => Promise<void>
}

const pollConnectivitySummary = async (target: RuntimeTarget) => {
  const summary = await callRuntimeRpc(target, 'connectivity.getSummary', {})
  set({ connections: keyBy(summary.connections, 'connectionId') })
}
```

Poll trigger theo đúng CR-STORAGE-007 mục 3: app foreground trở lại, mỗi
30s khi app đang mở, và ngay sau 1 RPC ghi thất bại nghi do mất kết nối dev
server (kiểm tra `err.code`/timeout trước khi coi là do connectivity, tránh
poll dư thừa cho lỗi logic thông thường).

## 6. UI — banner connectivity, không thiết kế chi tiết ở đây

Solution này chỉ đảm bảo dữ liệu (`connections[connectionId].status`) có
mặt trong store; thiết kế UI cụ thể (banner/badge/toast khi `degraded`) là
1 việc UX riêng, làm theo `docs/STYLEGUIDE.md` khi implement — không quy
định component cụ thể ở đây.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/store/slices/dev-servers.ts` | MODIFY — thêm `hydrateDevServers` |
| `frontend/src/renderer/src/store/slices/remote-agent-sessions.ts` | MODIFY — thêm `hydrateRemoteAgentSessions` |
| `frontend/src/renderer/src/store/slices/bootstrap.ts` | MODIFY — thêm `resumeBootstrapProgressIfAny` |
| `frontend/src/renderer/src/store/slices/ssh.ts`, `provisioning.ts`, `runtime-environment-ssh.ts` | MODIFY — cùng pattern hydrate |
| `frontend/src/renderer/src/store/slices/connectivity-status.ts` | MỚI |
| `frontend/src/renderer/src/store/slices/persistence-status.ts` (từ FE-SOL-STORAGE-002) | MODIFY — thêm namespace `devServers`/`agentSessions`/`sshFleet` |

## Rủi ro / Cần xác nhận trước khi implement

| Hạng mục | Ghi chú |
|---|---|
| `agentSession.listActive`/`connectivity.getSummary` là RPC/wscompat channel mới ở BE-SOL-002 | Không thể implement phần frontend này trước khi backend-go RPC tồn tại |
| Mapping `DispatchContext` (`assignee_handle`) → `RemoteAgentSession` shape hiện có trong frontend | Cần đối chiếu 2 shape này kỹ trước khi viết `mapDispatchContextsToSessions` — có thể lệch field, cần adapter rõ ràng |
| Poll `connectivity.getSummary` chồng lấn với poll `stats.ts`/`preflight.ts` đã có | Thấp — cần rà soát để không tạo 2 interval riêng cho cùng mục đích "theo dõi trạng thái kết nối" |

## Không thuộc phạm vi solution này

- Ngữ nghĩa reconnect-resume (giữ nguyên `ptyId`/`connectionId`, không trip
  circuit-breaker) — đó là hành vi **backend-go**, xem
  [BE-SOL-STORAGE-003](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-003-connection-reconnect-resume-contract.md);
  phần UX phía frontend cho việc reconnect nằm ở
  [FE-SOL-STORAGE-007](./FE-SOL-STORAGE-007-reconnect-preserves-session-state.md).
- Thiết kế UI banner/badge cụ thể — chỉ đảm bảo dữ liệu có trong store.

## Liên quan

- `specs/frontend/storage/dev-server-agent-impact.md`
- `frontend/src/renderer/src/store/slices/dev-servers.ts`, `remote-agent-sessions.ts`, `bootstrap.ts`, `ssh.ts`, `provisioning.ts`, `runtime-environment-ssh.ts`
- [BE-SOL-STORAGE-002](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-002-dev-server-agent-hydration-and-health.md)
- [FE-SOL-STORAGE-002](./FE-SOL-STORAGE-002-zustand-persist-backend-storage.md) (`persistence-status.ts` được mở rộng ở đây)
