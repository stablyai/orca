# Frontend Solutions — Storage Consolidation

**CRs:** [docs/crs/v3/storage/](../../../../../docs/crs/v3/storage/README.md)
**Backend-go counterpart:** [specs/backend-go/crs/v3/storage/solutions/](../../../../backend-go/crs/v3/storage/solutions/README.md)

## Solutions

| Solution | CR | Depends on | Status |
|---|---|---|---|
| [FE-SOL-STORAGE-001](./FE-SOL-STORAGE-001-local-app-hybrid-rpc-clients.md) | CR-STORAGE-001 | BE-SOL-STORAGE-001 | 🔲 Designed |
| [FE-SOL-STORAGE-002](./FE-SOL-STORAGE-002-zustand-persist-backend-storage.md) | CR-STORAGE-002 | FE-SOL-STORAGE-001, FE-SOL-STORAGE-003 | 🔲 Designed |
| [FE-SOL-STORAGE-003](./FE-SOL-STORAGE-003-full-settings-sync.md) | CR-STORAGE-003 | BE-SOL-STORAGE-001 | 🔲 Designed |
| [FE-SOL-STORAGE-004](./FE-SOL-STORAGE-004-workspace-session-accounts-devserver-sync.md) | CR-STORAGE-004 (phần a, b) | BE-SOL-STORAGE-001 | 🔲 Designed |
| [FE-SOL-STORAGE-005](./FE-SOL-STORAGE-005-remove-diagnostic-modules.md) | CR-STORAGE-005 | Không | 🔲 Designed — sẵn sàng implement ngay sau khi xác nhận điều kiện tiên quyết |
| [FE-SOL-STORAGE-006](./FE-SOL-STORAGE-006-dev-server-agent-state-hydration.md) | CR-STORAGE-006, CR-STORAGE-007 | BE-SOL-STORAGE-002 | 🔲 Designed |
| [FE-SOL-STORAGE-007](./FE-SOL-STORAGE-007-reconnect-preserves-session-state.md) | CR-STORAGE-008 | Phần (a) độc lập; phần resume phụ thuộc BE-SOL-STORAGE-003 | 🔲 Designed |

## Thứ tự thực thi

### Track 1 — `tenant-service` (preference cá nhân)

```
FE-SOL-STORAGE-005 → độc lập, làm bất cứ lúc nào (chỉ cần xác nhận bug đã đóng)

BE-SOL-STORAGE-001 (backend-go, xem thư mục kia) → PHẢI xong trước
  ↓
FE-SOL-STORAGE-001 (keybindings/ui-local/saved-server-list)
FE-SOL-STORAGE-003 (full settings sync)         → có thể làm song song với 001
FE-SOL-STORAGE-004 (workspaceSession/accountsDevServer)  → có thể làm song song
  ↓
FE-SOL-STORAGE-002 (Zustand persist middleware) → làm SAU CÙNG, cần RPC thật từ 001/003/004
```

### Track 2 — `infra-fleet-service`/`orchestration-service` (dev-server/agent)

```
FE-SOL-STORAGE-007(a) → độc lập, làm ngay (tách auth-failure khỏi logout)

BE-SOL-STORAGE-002 (backend-go) → PHẢI xong trước
  ↓
FE-SOL-STORAGE-006 (hydrate dev-servers/agent-sessions/ssh + connectivity-status)
  ↓
BE-SOL-STORAGE-003 (backend-go) → state machine reconnect-resume
  ↓
FE-SOL-STORAGE-007(resume UX) → phần còn lại của CR-STORAGE-008, cần (3) để có ý nghĩa
```

2 track độc lập nhau — không cần chờ Track 1 xong mới bắt đầu Track 2.

## Nguyên tắc chung áp dụng cho toàn bộ 7 solution "Designed"

1. **Không đổi hành vi desktop hiện có** — mọi thay đổi chỉ thêm nhánh mới
   cho `target.kind === 'environment'` (web hoặc desktop-paired-với-remote-
   environment); nhánh `window.api.*` desktop-local giữ nguyên 100%.
2. **`localStorage` không bị xoá bỏ ngoài ý muốn** — tiếp tục đóng vai trò
   cache đọc nhanh/offline-fallback; backend-go là nguồn thật mới, không
   thay thế local-first behavior. Ngoại lệ duy nhất, có chủ đích: logout đã
   xác nhận (FE-SOL-STORAGE-007 phần b) — đó là hành vi **mong muốn**, không
   phải regression của nguyên tắc này.
3. **Seed 1 lần khi backend-go chưa có bản ghi** — tránh reset dữ liệu
   người dùng hiện có về mặc định ngay sau khi rollout (áp dụng nhất quán ở
   FE-SOL-STORAGE-001/003/004; track 2 không cần seed vì dữ liệu vốn đã
   sống ở backend-go, không có bản localStorage cũ cần di chuyển).
4. **Không transport push mới** — mọi đồng bộ đều qua RPC request/response
   đã có (`callRuntimeRpc`), không WebSocket/polling mới nào được thêm bởi
   nhóm CR này (FE-SOL-STORAGE-006's `connectivity.getSummary` là poll, không
   phải push).

## Rủi ro cần review riêng trước khi implement bất kỳ solution nào

Xem [FE-SOL-STORAGE-003](./FE-SOL-STORAGE-003-full-settings-sync.md)'s
mục "Rủi ro" — **security review `vapidKeys`/`webPushSubscriptions`/
`codexManagedAccounts`/`claudeManagedAccounts`** là điều kiện tiên quyết
trước khi đồng bộ toàn bộ `GlobalSettings` lên backend-go dùng chung hạ
tầng multi-tenant.
