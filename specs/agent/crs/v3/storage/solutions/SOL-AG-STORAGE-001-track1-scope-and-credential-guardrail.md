# SOL-AG-STORAGE-001: Phạm vi agent cho track 1 (CR-STORAGE-001/002/003/004/005) — chủ yếu không cần đổi gì, trừ 1 ràng buộc bắt buộc

> **🔲 Designed — không có code nào trong `agent/src/` bị đổi ở solution
> này.** 4 trong 5 CR không có việc gì cho agent làm — dữ liệu thuộc về
> đây thuần là preference cá nhân/tab-layout của **frontend**, đi qua
> `tenant-service`, không liên quan tới execution trên dev server. CR còn
> lại (CR-STORAGE-003) có **1 ràng buộc bắt buộc phải giữ** trước khi
> implement, xác nhận bằng cách đọc chính source thật của
> `agent/src/relay/agent-credential-store.ts`, không chỉ suy đoán từ tên
> field.

**CRs:** [CR-STORAGE-001](../../../../../../docs/crs/v3/storage/CR-STORAGE-001-local-app-storage-to-backend-go.md) · [CR-STORAGE-002](../../../../../../docs/crs/v3/storage/CR-STORAGE-002-zustand-persist-middleware-backend-go.md) · [CR-STORAGE-003](../../../../../../docs/crs/v3/storage/CR-STORAGE-003-full-settings-sync-per-user.md) · [CR-STORAGE-004](../../../../../../docs/crs/v3/storage/CR-STORAGE-004-session-and-connection-keys-to-backend.md) · [CR-STORAGE-005](../../../../../../docs/crs/v3/storage/CR-STORAGE-005-cleanup-diagnostic-modules.md)
**backend-go counterpart:** [BE-SOL-STORAGE-001](../../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
**Frontend counterpart:** [FE-SOL-STORAGE-001/002/003/004/005](../../../../../frontend/crs/v3/storage/solutions/README.md)
**TDD tham chiếu:** [TDD-AG-09](../../../../tdd/v5/09-ai-credential-relay.md) — AI Credential Relay

---

## 1. CR-STORAGE-001, 002, 004, 005 — xác nhận không có phạm vi agent

Đọc lại 4 CR này đối chiếu với vai trò của Dev Server Agent
(`specs/agent/tdd/v5/00-index.md` §A.1 — "Execution Environment / Code
Host / File System Provider / Git Operations Host / AI Credential Store /
Workflow Step Executor / Health Reporter / AI Agent CLI Host / External
API Caller"):

| CR | Dữ liệu | Vì sao agent không liên quan |
|---|---|---|
| CR-STORAGE-001 | `keybindings.json`, `PersistedUIState` (phần local), saved-server-list | Thuần preference UI của **frontend renderer** — agent không đọc, không ghi, không có khái niệm "keybinding" |
| CR-STORAGE-002 | Zustand `persist` middleware (kiến trúc store frontend) | Agent không chạy Zustand, không có store nào tương ứng |
| CR-STORAGE-004 | `orca.web.workspaceSession.v1` (tab/layout), `orca.saved-instances` | Trạng thái UI/tab của browser — agent không biết "tab" là gì, chỉ biết `ptyId`/`connectionId` (đã xử lý riêng ở track 2) |
| CR-STORAGE-005 | Dọn dẹp 2 module diagnostic-log localStorage | Nằm hoàn toàn trong `frontend/src/renderer/src/lib/*.ts` |

**Kết luận**: không có solution agent riêng cho 4 CR này — ghi nhận ở đây
để bộ CR-STORAGE-00x có đủ 3 phía (backend-go/frontend/agent) trả lời rõ
ràng "agent có cần đổi gì không", thay vì im lặng bỏ qua.

## 2. CR-STORAGE-003 — ràng buộc bắt buộc: KHÔNG đưa field dạng credential vào `client_settings_json`

CR-STORAGE-003 đề xuất đồng bộ **toàn bộ** `GlobalSettings` (~200 field,
gồm `codexManagedAccounts`, `claudeManagedAccounts`, `webPushSubscriptions`,
`vapidKeys`) lên `tenant-service` dưới dạng 1 JSON blob opaque. Bảng rủi ro
của chính CR đó đã tự flag mục này là "Cao — cần security review riêng".
Solution này **xác nhận bằng đọc source thật** vì sao rủi ro đó là có cơ
sở, không phải suy đoán:

`specs/agent/tdd/v5/09-ai-credential-relay.md` §1 ghi rõ:

> **CRITICAL CONSTRAINT**: Credentials phải lưu trên Dev Server. Orca
> Server chỉ lưu metadata.

Và cơ chế thật (`agent/src/relay/agent-credential-store.ts`, xác nhận file
tồn tại trong `agent/src/relay/`) triển khai đúng constraint đó: browser
mã hoá client-side bằng `SubtleCrypto` → Orca Server **relay thẳng, không
decrypt** → Dev Server Agent mã hoá lớp 2 (scrypt-derived key từ
`ORCA_AI_CREDENTIAL_KEY`, AES-256-GCM) → lưu `~/.orca/credentials/<accountId>.enc`
(mode 0600) **trên chính dev server đó**. Plaintext API key **không bao
giờ** rời khỏi trình duyệt (dưới dạng đã mã hoá) hoặc dev server (dưới
dạng plaintext tạm trong RAM lúc spawn) — Orca Server (kể cả `tenant-service`
mới ở CR-STORAGE-003) không bao giờ thấy plaintext.

**Hệ quả bắt buộc cho CR-STORAGE-003 khi implement**: trước khi gộp
`codexManagedAccounts`/`claudeManagedAccounts` (và bất kỳ field nào có thể
chứa/tham chiếu credential) vào `client_settings_json`, PHẢI xác nhận từng
field:

1. Nếu field chỉ chứa **metadata tham chiếu** (ví dụ `accountId`, tên
   hiển thị, provider, trạng thái "đã kết nối") — an toàn để đồng bộ
   opaque như các field khác.
2. Nếu field chứa hoặc có thể chứa **key/token thật** (dù đã mã hoá 1 lớp
   phía client) — **KHÔNG** đưa vào `client_settings_json`. Route đúng qua
   luồng đã có ở mục này (browser encrypt → relay → Dev Server Agent
   decrypt-lưu-local) — đây là cơ chế đã tồn tại và đã đúng, CR-STORAGE-003
   không được tạo ra 1 đường đi thứ hai cho cùng loại dữ liệu.

Đây là **điều kiện tiên quyết bắt buộc** (không phải gợi ý) trước khi
FE-SOL-STORAGE-003/BE-SOL-STORAGE-001 coi `client_settings_json` là "sẵn
sàng đồng bộ toàn bộ `GlobalSettings`" — nếu chưa audit xong danh sách
field, phải loại trừ tạm các field nghi ngờ khỏi vòng đồng bộ đầu tiên
(allowlist ngược: mặc định loại trừ field chưa xác nhận, không mặc định
đưa vào).

## 2a. Kết quả audit (TASK-AG-STORAGE-001, 2026-09-07) — verified qua đọc source thật

Đọc trực tiếp `GlobalSettings` (`frontend/src/shared/types.ts`, đối chiếu
với bản y hệt ở `backend/`/`desktop/`/`agent/src/shared/types.ts`) cho
từng field nghi ngờ:

| Field | Shape thật | Phân loại | Vì sao |
|---|---|---|---|
| `codexManagedAccounts: CodexManagedAccount[]` | `{id, email, managedHomePath, managedHomeRuntime?, wslDistro?, providerAccountId?, workspaceLabel?, workspaceAccountId?, createdAt, updatedAt, lastAuthenticatedAt}` | ✅ **Metadata-only, an toàn** | Không có field nào chứa token/key. `managedHomePath` là **đường dẫn filesystem** (nơi Codex CLI tự quản lý auth của nó), không phải bản thân secret — biết đường dẫn không cấp quyền truy cập nếu không có quyền đọc file trên đúng máy đó |
| `claudeManagedAccounts: ClaudeManagedAccount[]` | `{id, email, managedAuthPath, managedAuthRuntime?, wslDistro?, authMethod: 'subscription-oauth'\|'unknown', organizationUuid?, organizationName?, createdAt, updatedAt, lastAuthenticatedAt}` | ✅ **Metadata-only, an toàn** | Cùng lý do — `managedAuthPath` là đường dẫn, không phải token. Đây là account OAuth/subscription (Claude Code's own CLI login), **khác hẳn** cơ chế `agent-credential-store.ts` (API-key-based, cho `ai.provider.writeCredential`) |
| `vapidKeys?: { publicKey: string; privateKey: string } \| null` | (`frontend/src/shared/types.ts`, comment: "Generated once and persisted. Phase 3 — TASK-032") | 🔴 **KHÔNG an toàn — chứa `privateKey` thật** | Đây là VAPID key pair dùng để ký Web Push message — `privateKey` là secret material thật, nằm ngay trong `GlobalSettings`. **Loại trừ hoàn toàn khỏi `client_settings_json`** |
| `webPushSubscriptions?: WebPushSubscription[]` | (chưa đọc đầy đủ shape `WebPushSubscription`, nhưng theo chuẩn Web Push API luôn gồm `endpoint` + `keys.{p256dh,auth}`) | 🟡 **Cần thận trọng — dạng bearer credential** | `endpoint`+`keys` cho phép gửi push tới đúng thiết bị đó; rò rỉ không lộ trực tiếp `vapidKeys.privateKey` nhưng vẫn là 1 dạng credential-shaped data. Khuyến nghị loại trừ khỏi vòng đồng bộ đầu tiên cho tới khi có security review riêng, nhất quán với cách xử lý `vapidKeys` |

**Kết luận cho CR-STORAGE-003**: `codexManagedAccounts`/`claudeManagedAccounts`
**AN TOÀN** để đồng bộ opaque trong `client_settings_json` — nỗi lo ban đầu
(cùng tên "managed accounts" gợi liên tưởng tới `agent-credential-store.ts`)
không thành sự thật khi đọc đúng shape. Ngược lại, `vapidKeys` **PHẢI loại
trừ** (secret thật, đã xác nhận) và `webPushSubscriptions` **nên loại trừ**
(thận trọng, credential-shaped). Đây là allowlist ngược cụ thể, thay cho
khuyến nghị chung chung ở §2 gốc.

**Lưu ý phát sinh, ngoài phạm vi CR-STORAGE-003**: `vapidKeys.privateKey`
hiện đã nằm trong `GlobalSettings` **kể cả hôm nay, trước khi có CR này** —
nghĩa là bất kỳ đường ghi `settings.update` nào cho phép client gửi lại
field này đều là 1 rủi ro sẵn có (client có thể gửi 1 `privateKey` cũ/giả
mạo, ghi đè key thật của server) — không phải lỗi do CR-STORAGE-003 tạo ra,
nhưng CR-STORAGE-003 (đồng bộ full-object) làm rủi ro này rõ ràng hơn nếu
không loại trừ field. Ghi nhận như 1 phát hiện phụ, không thuộc phạm vi sửa
của solution này.

## 3. Rủi ro / Kiểm thử cần có

| Hạng mục | Ghi chú |
|---|---|
| Audit từng field của `GlobalSettings` xem có chứa credential material hay chỉ metadata | Bắt buộc, chưa làm trong phiên này — cần đọc `frontend/src/shared/types.ts:2524`'s field definitions đối chiếu với agent-credential-store's `accountId`-only shape |
| `TestClientSettingsSyncExcludesCredentialShapedFields` | Test regression-guard đề xuất ở phía backend-go/frontend (không phải agent) — ghi ở đây để không lạc mất ràng buộc khi implement |
| Không có gì cần sửa trong `agent/src/` | Xác nhận — solution này không đổi `agent-credential-store.ts` hay bất kỳ file agent nào, chỉ đặt ràng buộc cho phía backend-go/frontend |

## Không thuộc phạm vi solution này

- Bất kỳ thay đổi code trong `agent/src/`.
- Track 2 (CR-STORAGE-006/007/008) — xem
  [SOL-AG-STORAGE-002](./SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md)/
  [SOL-AG-STORAGE-003](./SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md).

## Liên quan

- `specs/agent/tdd/v5/09-ai-credential-relay.md`
- `agent/src/relay/agent-credential-store.ts`
- `docs/crs/v3/storage/CR-STORAGE-003-full-settings-sync-per-user.md` (mục Rủi ro, đã tự flag)
- [BE-SOL-STORAGE-001](../../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
