# BE-SOL-STORAGE-001: Thêm các cột JSON per-user opaque vào `tenant.user_profiles`

> **🔲 Designed — chưa implement.** Không có code nào trong `backend-go/`
> bị đổi ở solution này. Đây là thiết kế chi tiết (schema/gRPC/wscompat)
> theo đúng pattern đã có sẵn và đang chạy (`onboarding_state_json`), đủ cụ
> thể để 1 phiên implement sau có thể bắt tay vào ngay — nhưng cố tình
> **không viết code thật** trong phiên này vì đây là bảng `tenant-service`
> sở hữu — Phase 4 (do-last), high-blast-radius theo
> `specs/backend-go/tdd/services/tenant-service.md`'s §10, cần review
> riêng trước khi đụng migration.

**CRs:** [CR-STORAGE-001](../../../../../../docs/crs/v3/storage/CR-STORAGE-001-local-app-storage-to-backend-go.md) · [CR-STORAGE-003](../../../../../../docs/crs/v3/storage/CR-STORAGE-003-full-settings-sync-per-user.md) · [CR-STORAGE-004](../../../../../../docs/crs/v3/storage/CR-STORAGE-004-session-and-connection-keys-to-backend.md) (phần a, b)
**Service:** `tenant-service` (schema, migration, gRPC) + `api-gateway` (wscompat wiring)
**Frontend counterpart:** [specs/frontend/crs/v3/storage/solutions/](../../../../frontend/crs/v3/storage/solutions/README.md)
**TDD tham chiếu:** [`specs/backend-go/tdd/services/tenant-service.md`](../../../../tdd/services/tenant-service.md) §5 (Data model), §6 (Package layout), §9 (Security notes)

---

## 1. Vì sao gộp 3 CR vào 1 solution

CR-STORAGE-001/003/004(a,b) đều cần **chính xác cùng 1 loại thay đổi**:
thêm 1 cột `TEXT`/`JSONB` opaque vào `tenant.user_profiles`, cùng 1 cặp
`Get*`/`Set*` repository method, cùng 1 cặp gRPC method, cùng 1 cặp wscompat
channel — chỉ khác tên cột và namespace RPC. Viết 3 solution riêng sẽ lặp
lại y hệt boilerplate migration/repository 3 lần. Theo đúng tinh thần
`FE-SOL-001` (project-workspace) gộp CR-PW-001+002 vì "cùng 1 solution,
cùng file" — ở đây là "cùng 1 bảng, cùng 1 pattern, khác cột".

## 2. Pattern gốc đã có sẵn, xác nhận bằng đọc code thật

`tenant.user_profiles` đã có tiền lệ **chính xác** cho bài toán này —
`onboarding_state_json`, thêm sau khi nhận ra "per-user onboarding wizard
progress ... nothing ever persisted this" (doc comment,
`backend-go/proto/gen/go/orca/tenant/v1/tenant_grpc.pb.go:85-90`):

```go
// backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go:119-160
func (r *UserProfileRepository) GetOnboardingState(ctx context.Context, companyID, userID string) (string, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT onboarding_state_json FROM tenant.user_profiles
		WHERE user_id = $1 AND company_id = $2
	`, userID, companyID)
	// ... found=false khi NULL hoặc không có row
}

func (r *UserProfileRepository) SetOnboardingState(ctx context.Context, companyID, userID, stateJSON string) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO tenant.user_profiles (user_id, company_id, onboarding_state_json)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET
			onboarding_state_json = EXCLUDED.onboarding_state_json,
			updated_at            = now()
	`, userID, companyID, stateJSON)
}
```

Và lý do **cột riêng, không dùng `settings_json` layered** (đã tồn tại cho
`ResolveProfile`'s company→department→team→user merge, xem
`tenant-service.md` §4): `onboarding_state_json` là dữ liệu opaque,
tenant-service không cần biết schema, và không tham gia merge nhiều-tầng.
Cả 4 loại dữ liệu CR-001/003/004 cần lưu — `PersistedUIState`,
`GlobalSettings`, `WorkspaceSessionState`, `Record<envId,devServerId>` —
đều là **opaque JSON của phía frontend**, tenant-service không cần decode
field nào trong đó. Đúng y hệt lý do `onboarding_state_json` tồn tại tách
biệt.

## 3. Migration đề xuất (additive, nullable — không đổi cột hiện có)

```sql
-- backend-go/services/tenant-service/migrations/XXXX_user_profile_client_state.up.sql
ALTER TABLE tenant.user_profiles
  ADD COLUMN keybindings_json                TEXT NULL,
  ADD COLUMN ui_local_state_json             TEXT NULL,
  ADD COLUMN saved_runtime_environments_json TEXT NULL,
  ADD COLUMN client_settings_json            TEXT NULL,
  ADD COLUMN workspace_session_json          TEXT NULL,
  ADD COLUMN accounts_dev_server_json        TEXT NULL;

-- down migration: xoá cả 6 cột, đúng thứ tự ngược
```

**Vì sao `TEXT` chứ không `JSONB`** — mirror đúng kiểu cột
`onboarding_state_json` đang dùng (xác nhận đọc schema thật:
`user_profile_repository.go`'s `SELECT onboarding_state_json` scan vào
`*string`, không có `jsonb` cast) — nhất quán với cột tiền lệ, tránh 2 kiểu
lưu JSON khác nhau trong cùng 1 bảng mà không có lý do kỹ thuật rõ ràng.
Nếu 1 phiên implement sau xác nhận cần index/query nội dung JSON (không có
nhu cầu nào ở đây — tất cả đều là "đọc nguyên khối, ghi đè nguyên khối"),
đổi sang `JSONB` là 1 quyết định riêng, không mặc định trong solution này.

**`workspace_session_json` cần thêm chiều "theo host"** — khác 5 cột còn
lại (khoá thuần theo `user_id`), CR-STORAGE-004(a) ghi rõ
`WorkspaceSessionState` cần phân vùng theo `hostId`/`environmentId` (mirror
`sessionStorageKeyForHost()` phía frontend). **Không** thêm cột đơn — dùng
1 bảng phụ mới thay vì nhồi thêm chiều vào `user_profiles` (1 user có thể
có N session, không phải 1:1):

```sql
CREATE TABLE tenant.user_workspace_sessions (
  user_id     UUID NOT NULL,       -- logical FK → auth.users
  company_id  UUID NOT NULL,       -- FK → companies.id, cho RLS
  host_id     TEXT NOT NULL,       -- 'local' hoặc environmentId; rỗng = default
  session_json TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, host_id)
);
CREATE INDEX idx_user_workspace_sessions_company ON tenant.user_workspace_sessions(company_id);
-- RLS: current_setting('app.tenant_id') so với company_id, cùng pattern §9 tenant-service.md
```

## 4. Repository methods mới (`user_profile_repository.go`)

6 cặp `Get*`/`Set*`, đúng chữ ký `(ctx, companyID, userID) (string, bool, error)` /
`(ctx, companyID, userID, json string) error` như `GetOnboardingState`/
`SetOnboardingState` — chỉ đổi tên cột trong câu SQL:

```go
func (r *UserProfileRepository) GetKeybindings(ctx context.Context, companyID, userID string) (string, bool, error)
func (r *UserProfileRepository) SetKeybindings(ctx context.Context, companyID, userID, json string) error

func (r *UserProfileRepository) GetUILocalState(ctx context.Context, companyID, userID string) (string, bool, error)
func (r *UserProfileRepository) SetUILocalState(ctx context.Context, companyID, userID, json string) error

func (r *UserProfileRepository) GetSavedRuntimeEnvironments(ctx context.Context, companyID, userID string) (string, bool, error)
func (r *UserProfileRepository) SetSavedRuntimeEnvironments(ctx context.Context, companyID, userID, json string) error

func (r *UserProfileRepository) GetClientSettings(ctx context.Context, companyID, userID string) (string, bool, error)
func (r *UserProfileRepository) SetClientSettings(ctx context.Context, companyID, userID, json string) error

func (r *UserProfileRepository) GetAccountsDevServerMap(ctx context.Context, companyID, userID string) (string, bool, error)
func (r *UserProfileRepository) SetAccountsDevServerMap(ctx context.Context, companyID, userID, json string) error
```

`workspace_session` đi vào 1 repository mới `UserWorkspaceSessionRepository`
(bảng riêng, khoá `(user_id, host_id)`), 3 method: `Get(ctx, companyID,
userID, hostID)`, `Set(ctx, companyID, userID, hostID, json)`, `Patch(ctx,
companyID, userID, hostID, patchJSON)` — `Patch` cần đọc-sửa-đè trong 1
transaction (`SELECT ... FOR UPDATE` rồi `UPDATE`) để tránh mất field khi 2
patch gần nhau ghi đè nhau (khác 5 method `Set*` còn lại — luôn ghi đè toàn
bộ, không có "patch" nào ở CR-001/003).

## 5. gRPC — proto additions

Thêm vào `backend-go/proto/orca/tenant/v1/tenant.proto`, theo đúng khuôn
`GetOnboardingState`/`SetOnboardingState` (`tenant.proto`, xem message
`GetOnboardingStateRequest`/`Response`/`SetOnboardingStateRequest` hiện
có):

```protobuf
// ── Client-local state (CR-STORAGE-001/003/004) ───────────────────────
message GetClientStateRequest {
  string user_id = 1;
  // kind chọn đúng 1 trong 5 cột đơn (không phải workspace_session,
  // xem GetWorkspaceSession riêng) — tránh 5 cặp RPC gần như giống hệt nhau.
  ClientStateKind kind = 2;
}
message GetClientStateResponse {
  string state_json = 1;
  bool found = 2;
}
message SetClientStateRequest {
  string user_id = 1;
  ClientStateKind kind = 2;
  string state_json = 3;
}

enum ClientStateKind {
  CLIENT_STATE_KIND_UNSPECIFIED = 0;
  CLIENT_STATE_KIND_KEYBINDINGS = 1;
  CLIENT_STATE_KIND_UI_LOCAL = 2;
  CLIENT_STATE_KIND_SAVED_RUNTIME_ENVIRONMENTS = 3;
  CLIENT_STATE_KIND_SETTINGS = 4;
  CLIENT_STATE_KIND_ACCOUNTS_DEV_SERVER_MAP = 5;
}

// ── Workspace session (CR-STORAGE-004a) — bảng riêng, có host_id ──────
message GetWorkspaceSessionRequest {
  string user_id = 1;
  string host_id = 2;  // rỗng = 'local'
}
message GetWorkspaceSessionResponse {
  string session_json = 1;
  bool found = 2;
}
message SetWorkspaceSessionRequest {
  string user_id = 1;
  string host_id = 2;
  string session_json = 3;
}
message PatchWorkspaceSessionRequest {
  string user_id = 1;
  string host_id = 2;
  string patch_json = 3;  // merge nông vào bản ghi hiện có, phía server
}
```

**Quyết định thiết kế: 1 cặp RPC tham số hoá bằng `enum ClientStateKind`
thay vì 5 cặp RPC riêng** (`GetKeybindings`/`GetUILocalState`/...) — khác
với cách `onboarding_state_json` có RPC riêng của chính nó. Lý do: cả 5
loại state này có đúng 1 hình dạng thao tác (get/set nguyên khối theo
`user_id`, không có logic nghiệp vụ riêng nào khác nhau giữa chúng) — tham
số hoá tránh nhân bản 10 RPC method gần như giống hệt nhau trên
`TenantServiceClient` (đã có 23 method, xem `tenant_grpc.pb.go`). Nếu 1
trong 5 loại sau này cần logic riêng (ví dụ validate schema), tách nó ra
thành RPC riêng lúc đó — không tối ưu sớm ở đây.

Thêm vào `Server` interface (`internal/adapter/grpc/server.go`):

```go
func (s *Server) GetClientState(ctx context.Context, req *tenantv1.GetClientStateRequest) (*tenantv1.GetClientStateResponse, error)
func (s *Server) SetClientState(ctx context.Context, req *tenantv1.SetClientStateRequest) (*emptypb.Empty, error)
func (s *Server) GetWorkspaceSession(ctx context.Context, req *tenantv1.GetWorkspaceSessionRequest) (*tenantv1.GetWorkspaceSessionResponse, error)
func (s *Server) SetWorkspaceSession(ctx context.Context, req *tenantv1.SetWorkspaceSessionRequest) (*emptypb.Empty, error)
func (s *Server) PatchWorkspaceSession(ctx context.Context, req *tenantv1.PatchWorkspaceSessionRequest) (*emptypb.Empty, error)
```

`usecase/` mới: `GetClientState`/`SetClientState` (dispatch theo `kind` tới
đúng repository method — 1 `switch` nhỏ, không có business logic khác);
`GetWorkspaceSession`/`SetWorkspaceSession`/`PatchWorkspaceSession` gọi
thẳng `UserWorkspaceSessionRepository`. Theo đúng package layout
`tenant-service.md` §6 — `usecase/` không biết Postgres, chỉ gọi qua port
interface (`ports.go` thêm 2 interface mới:
`ClientStateRepository`, `WorkspaceSessionRepository`).

## 6. wscompat — namespace mới trên `api-gateway`

Theo đúng khuôn `channels_tenant_project.go:118-147` (`profile.getUserProfile`),
**namespace mới** `clientState.*`/`workspaceSession.*` (không đụng
`profile.*`/`ui.*`/`settings.*` hiện có):

```go
// backend-go/services/api-gateway/internal/adapter/wscompat/channels_client_state.go (MỚI)
r.Register("clientState.get", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	var a struct{ Kind string `json:"kind"` }
	if err := decodeArg(args, 0, &a); err != nil { return nil, err }
	kind, err := parseClientStateKind(a.Kind) // "keybindings"|"uiLocal"|"savedRuntimeEnvironments"|"settings"|"accountsDevServerMap"
	if err != nil { return nil, err }
	resp, err := tenantClient.GetClientState(rpcCtx, &tenantv1.GetClientStateRequest{
		UserId: id.UserID, Kind: kind,
	})
	if err != nil { return nil, err }
	if !resp.GetFound() { return map[string]any{"found": false}, nil }
	return map[string]any{"found": true, "stateJson": resp.GetStateJson()}, nil
})

r.Register("clientState.set", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
	var a struct{ Kind string `json:"kind"`; StateJson string `json:"stateJson"` }
	if err := decodeArg(args, 0, &a); err != nil { return nil, err }
	kind, err := parseClientStateKind(a.Kind)
	if err != nil { return nil, err }
	_, err = tenantClient.SetClientState(rpcCtx, &tenantv1.SetClientStateRequest{
		UserId: id.UserID, Kind: kind, StateJson: a.StateJson,
	})
	return nil, err
})

// workspaceSession.get/.set/.patch — cùng khuôn, thêm HostId: a.HostId từ args
```

**`id.UserID` luôn lấy từ `Identity` đã xác thực, KHÔNG BAO GIỜ từ
`args`** — đúng quy tắc bảo mật đã kiểm chứng ở `BE-SOL-001`
("`TenantId` luôn lấy từ `Identity`, không bao giờ từ args") và
`tenant-service.md` §9's "never inferred from a nested resource ID".

## 7. Rủi ro / Kiểm thử cần có (khi implement thật)

| Hạng mục | Ghi chú |
|---|---|
| `TestClientStateChannel_UserIDComesFromIdentityNotArgs` | Regression-guard bắt buộc — mirror `TestWorkflowExecuteAdHocStepChannel_TenantIDComesFromIdentityNotArgs` (`BE-SOL-001`) |
| `TestGetClientState_NotFoundReturnsFoundFalse` | Đúng semantics `onboarding_state_json`'s "found=false khi NULL hoặc không có row" |
| `TestPatchWorkspaceSession_ConcurrentPatchesDoNotLoseFields` | `Patch` cần transaction đọc-sửa-đè — test race 2 patch gần nhau |
| `ProfileCache` invalidation | **Không áp dụng** — các cột mới KHÔNG tham gia `ResolveProfile`/`GetResolvedProfile`'s cache (chỉ `settings_json` layered mới cần invalidate, xem `tenant-service.md` §8) — cần ghi rõ trong code comment để tránh 1 người sau này tưởng nhầm phải gọi `ProfileCache.Invalidate` cho các cột này |
| RLS trên `tenant.user_workspace_sessions` | Bảng mới — phải bật RLS theo đúng pattern `current_setting('app.tenant_id')` như 4 bảng còn lại (`tenant-service.md` §5), không được bỏ sót vì đây là bảng phụ mới thêm |
| `buf generate` | Phải chạy sạch, không phá `proto/gen/go` dùng chung — đúng rủi ro đã ghi nhận ở `BE-SOL-001`/`CR-PW-006` |

## 8. Không thuộc phạm vi solution này

- `orca.saved-instances` (CR-STORAGE-004 phần c) — theo đúng CR, đây là dữ
  liệu bootstrap-trước-khi-biết-server, không map vào `tenant-service` của
  1 backend-go instance cụ thể nào. Không thiết kế ở đây.
- Migrate dữ liệu cũ từ `localStorage`/`orca-data.json` sang các cột mới —
  thuộc solution phía frontend (xem
  [FE-SOL-STORAGE-001](../../../../frontend/crs/v3/storage/solutions/FE-SOL-STORAGE-001-local-app-hybrid-rpc-clients.md)'s
  "seed từ localStorage lần đầu gọi").
- Đổi `settings_json` layered (company/department/team resolution) —
  không đụng, đây là bảng/cột khác, mục đích khác (xem §2).

## Liên quan

- `backend-go/services/tenant-service/internal/adapter/postgres/user_profile_repository.go`
- `backend-go/proto/orca/tenant/v1/tenant.proto`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_tenant_project.go`
- `specs/backend-go/tdd/services/tenant-service.md`
- [BE-SOL-001](../../project-workspace/solutions/BE-SOL-001-workflow-wscompat-wiring.md) (mẫu wscompat wiring + test pattern tham chiếu)
