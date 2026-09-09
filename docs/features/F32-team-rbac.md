# F32 — Team-based Access Control (RBAC)

| Trường | Giá trị |
|--------|---------|
| **ID** | F32 |
| **Tên** | Team-based Access Control (RBAC) |
| **Ưu tiên** | P2 |
| **Trạng thái** | ⚠️ Partial (backend-go: SSO OIDC/GitHub + OPA/Rego RBAC đã chạy; Admin UI/RBAC surface vẫn trên kiến trúc cũ — xem CR v4) |
| **CRs** | [remote-server/CR-006](../crs/v1/remote-server/CR-006-team-rbac.md) (kiến trúc cũ, Phase 1) · [v4/team-rbac](../crs/v4/team-rbac/README.md) (7 CR hoàn thiện F32 trên backend-go/frontend hiện tại) |
| **Phiên bản** | v4.1+ (Phase 1) |
| **ADR References** | — |
| **HLD References** | C3.1 |

---

## Mô tả

Orca Web Server hỗ trợ **phân quyền theo role** — global role (developer / admin) kết hợp với repo-scoped role (developer / lead / admin, xem note ở mục Roles bên dưới) — để kiểm soát ai được truy cập server nào, thực hiện hành động gì. Phase 1 implement types + policy resolution; Phase 2 tích hợp SSO (OIDC/SAML).

---

## Vấn đề cần giải quyết

Trong multi-user web mode không có RBAC:
- Mọi authenticated user đều thấy **tất cả** SSH targets trong fleet
- Không ngăn junior dev kết nối vào production server
- Không có audit trail ai kết nối vào server nào
- Security risk: developer project A vào được server project B

---

## Tính năng chi tiết

### Roles

> **Update (TASK-BE-006/CR-RBAC-002, confirmed against the current backend-go
> implementation):** the flat 3-tier table below (developer/lead/admin as one
> global role) is the OLD design sketch. The real model backend-go implements
> is **two independent axes**, not one flat enum:
>
> | Axis | Values | Where enforced |
> |------|--------|-----------------|
> | **Global role** | `user`, `admin` (`auth-service`'s `domain.Role`) — 2 values only, no global "lead" | `backend-go/policy/orca-authz/admin.rego` |
> | **Repo-scoped role** | `developer`, `lead`, `admin` (`RepoRole`) — assigned per-repo | `backend-go/policy/orca-authz/repo.rego`, granted via `project-service`'s `update_repo_member_role.go` |
>
> A user's global role and their `RepoRole` on any given repo are independent:
> a user can be global `user` but repo `admin` on one repo, or vice versa.
> Global `admin` additionally has an override branch in `project.rego`/
> `repo.rego` giving full access regardless of any repo-level role or
> membership (see `callerGlobalRole`, TASK-BE-003). Kept below for history;
> do not treat the flat table as the current contract.
>
> **Addendum (FE-TASK-005, CR-RBAC-002):** on the frontend, backend-go's
> global `user` value surfaces as `'developer'` — `OrcaUserRole`
> (`frontend/src/renderer/src/store/slices/auth.ts`) is `'developer' | 'admin'`,
> and `AuthUser.role` mirrors it 1:1 (FE-TASK-001/003, this CR). The frontend
> never had a global `'lead'` type to begin with; FE-TASK-001..004 only
> removed a *display* label that no global role value ever produced. This
> global 2-tier shape is **a deliberate simplification that pre-dates this
> CR** — it reflects how `auth-service`/`api-gateway` already modeled global
> roles; CR-RBAC-002 did not introduce or decide it, only propagated it
> through the frontend's own types so they stop implying a global `'lead'`
> that was never real.

| Role | Permissions |
|------|------------|
| `developer` | Xem + kết nối servers của project mình; tạo worktree; chạy agent |
| `lead` | Tất cả của developer + invite members; quản lý fleet của project; review |
| `admin` | Toàn quyền: tất cả servers, tất cả users, fleet management, system settings |

---

### Phase 1 — Types & Policy Resolution (Implemented)

```typescript
// src/shared/rbac-types.ts
interface RolePolicy {
  role: 'developer' | 'lead' | 'admin'
  resource: 'ssh_host' | 'fleet' | 'worktree' | 'admin_panel' | 'credentials'
  actions: ('read' | 'write' | 'delete' | 'admin')[]
}

function hasPermission(
  userId: string,
  resource: string,
  action: string,
  context?: { projectId?: string; serverId?: string }
): boolean

// Policy table example:
const POLICY_TABLE = {
  developer: {
    ssh_host: ['read'],           // chỉ thấy servers của project mình
    worktree: ['read', 'write'],  // tạo/xóa worktree của mình
    fleet: [],                    // không quản lý fleet
    admin_panel: [],              // không vào admin
  },
  lead: {
    ssh_host: ['read', 'write'],  // quản lý servers của project mình
    worktree: ['read', 'write', 'delete'],
    fleet: ['read', 'write'],     // manage fleet của project
    admin_panel: ['read'],        // xem admin, không edit users
  },
  admin: {
    ssh_host: ['read', 'write', 'delete', 'admin'],
    worktree: ['read', 'write', 'delete', 'admin'],
    fleet: ['read', 'write', 'delete', 'admin'],
    admin_panel: ['read', 'write', 'delete', 'admin'],
    credentials: ['read', 'write', 'delete', 'admin'],
  }
}
```

---

### Phase 1 — Database Schema

```sql
-- orca_users: đã có (F23)
ALTER TABLE orca_users ADD COLUMN role TEXT DEFAULT 'developer';
-- role: 'developer' | 'lead' | 'admin'

-- orca_access_policies (migration 0005)
CREATE TABLE orca_access_policies (
  user_id TEXT REFERENCES orca_users(id),
  project_id TEXT,                       -- NULL = all projects
  server_id TEXT,                        -- NULL = all servers
  role TEXT NOT NULL,
  granted_by TEXT REFERENCES orca_users(id),
  granted_at INTEGER,
  expires_at INTEGER,                    -- NULL = permanent
  PRIMARY KEY (user_id, project_id, server_id)
);

-- orca_audit_log (migration 0005)
CREATE TABLE orca_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT,   -- 'ssh.connect' | 'worktree.create' | 'admin.user.promote'
  resource_type TEXT,
  resource_id TEXT,
  outcome TEXT,  -- 'allowed' | 'denied'
  ip_address TEXT,
  timestamp INTEGER
);
```

---

### Phase 1 — Server-side Enforcement

```typescript
// RPC middleware: inject userId vào mọi RPC call
async function rpcHandler(method, params, context: RpcMethodContext) {
  const { userId } = context.session

  // Check permission before executing
  if (!hasPermission(userId, 'ssh_host', 'read', { serverId: params.serverId })) {
    throw new RpcError(403, 'Access denied')
    // → logged vào orca_audit_log với outcome: 'denied'
  }

  // Execute + log
  const result = await handler(params)
  await auditLog.record({ userId, action: method, outcome: 'allowed' })
  return result
}
```

---

### Phase 1 — Admin Panel Integration

Admin panel (F25) hiển thị thêm:
- User list với role badge (developer/lead/admin)
- Promote/demote role button (admin only)
- Per-user server access matrix
- Audit log table với filter theo user/action/outcome

---

### Phase 2 — SSO Integration (Pending)

```typescript
// Planned: OIDC/SAML provider integration
// Role mapping từ SSO groups:
//   SSO group "orca-admins"     → role: 'admin'
//   SSO group "orca-leads"      → role: 'lead'
//   SSO group "orca-developers" → role: 'developer'

interface SsoConfig {
  provider: 'oidc' | 'saml'
  issuerUrl: string
  clientId: string
  clientSecret: string  // từ ORCA_SSO_CLIENT_SECRET env
  groupMappings: Record<string, Role>
}
```

---

### Project-scoped Server Visibility

> **Note (TASK-BE-013/BE-SOL-004, confirmed against the current backend-go
> implementation):** the section below describes the OLD architecture's
> design sketch (project-scoped, SQL over `orca_access_policies`). The real
> scoping axis `infra-fleet-service` implements today is
> **Team/Department, not Project** — `ListDevServersForUser`
> (`infra-fleet-service/internal/usecase/list_dev_servers_for_user.go`)
> grants visibility per dev-server-group grant matching the caller's
> department OR team membership (resolved via `tenant-service`'s
> `GetUserProfile`/`ListTeamsForUser`), with no project dimension involved
> at all. Kept below for history; do not treat it as the current contract.
>
> **Addendum (FE-TASK-013, CR-RBAC-004):** on the frontend, this scoping axis
> is exercised via `devServerGroup.grant({ granteeKind: 'department' | 'team',
> granteeId, devServerGroupId })` (`AdminDevServerConsole.tsx`'s
> `GroupsAndGrantsTab`, FE-TASK-012) — there is no `project`/`OrcaUser.projects`
> field anywhere in this path any more (removed as dead code, FE-TASK-007/010).
> There is **no plan to add a "Project" scoping axis** to dev-server
> visibility — Team/Department is the chốt (finalized) architecture decision
> of CR-RBAC-004, not an interim state pending a project dimension.

```
Fleet → group by project:
  admin sees:   ALL servers (all projects)
  lead sees:    servers WHERE project IN user.projects
  developer sees: servers WHERE project IN user.projects
                             AND hasPermission(user, server, 'read')

SQL:
  SELECT s.* FROM ssh_targets s
  JOIN orca_access_policies p ON p.server_id = s.id OR p.server_id IS NULL
  WHERE p.user_id = ? AND p.role IN ('developer','lead','admin')
```

---

## Tiêu chí chấp nhận

**Phase 1 (✅ Implemented):**
- [x] `orca_users.role` column (developer/lead/admin)
- [x] `orca_access_policies` table (migration 0005)
- [x] `orca_audit_log` table (migration 0005)
- [x] `hasPermission()` function với policy table
- [x] RPC middleware check permission trước khi execute
- [x] Audit log mọi SSH connect + admin actions
- [x] Admin panel hiển thị roles, promote/demote UI

**Phase 2 (⏳ Pending):**
- [ ] OIDC provider configuration
- [ ] SAML provider configuration
- [ ] Group-to-role mapping
- [ ] SSO login flow (redirect + callback)
- [ ] Token refresh

---

## Yêu cầu kỹ thuật

| Component | File |
|-----------|------|
| RBAC types | `src/shared/rbac-types.ts` |
| Policy resolver | `src/main/auth/rbac-resolver.ts` |
| Audit log service | `src/main/auth/audit-log-service.ts` |
| RPC middleware | `src/main/runtime/rpc/runtime-rpc.ts` (extended) |
| DB migration | `src/main/db/migrations/0005_auth_schema.ts` |
| Admin RBAC UI | `src/renderer/src/components/admin/UserRoleManagement.tsx` |
| Admin audit log | `src/renderer/src/components/admin/AuditLogTable.tsx` |

**Phase 2 env:** `ORCA_SSO_PROVIDER`, `ORCA_SSO_ISSUER_URL`, `ORCA_SSO_CLIENT_ID`, `ORCA_SSO_CLIENT_SECRET`

---

## Metrics

| KPI | Mục tiêu |
|-----|----------|
| Permission check latency | < 1ms (in-memory policy table) |
| Audit log write | < 5ms (async, non-blocking) |
| Server list filter (1000 servers) | < 10ms |
| 0 permission bypass | Security requirement (P0) |
