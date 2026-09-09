# FE-TASK-FLEET-001: YAML schema — thêm `vaultSshRole` vào `FleetServerSchema`

**Solution:** [FE-FLEET-SOL-001](../solutions/FE-FLEET-SOL-001-yaml-schema-vault-ssh-role.md) | **CR:** CR-FLEET-001
**Service:** `frontend`
**Depends on:** Không
**Status:** ✅ DONE — 2026-09-09

## Kết quả thực tế

- Thêm `vaultSshRole: z.string().optional()` vào `FleetServerSchema`
  (`frontend/src/shared/fleet-config-parser.ts:57`), giữ nguyên
  `identityFile` + đánh dấu `@deprecated cho path backend-go` ngay tại field
  đó (dòng 42), đúng vị trí task mô tả.
- `impact()` trên `FleetServerSchema` (uid
  `Const:frontend/src/shared/fleet-config-parser.ts:FleetServerSchema`):
  risk LOW, 0 upstream caller bị ảnh hưởng — an toàn thêm field optional.
- Tạo mới `frontend/src/shared/fleet-config-parser.test.ts` (chưa tồn tại
  trước đó) — 3 test case đúng như task yêu cầu: chỉ `vaultSshRole`, chỉ
  `identityFile` (backward-compat), cả 2 cùng tồn tại. Chạy
  `npx vitest run --config config/vitest.config.ts src/shared/fleet-config-parser.test.ts`
  (lưu ý: phải truyền `--config config/vitest.config.ts`, lệnh trần trong
  task gốc không tìm thấy file vì root vitest mặc định trỏ vào
  `src/renderer`) — 3/3 pass.
- `npx tsc --noEmit -p .` — không phát sinh lỗi type mới liên quan
  `fleet-config-parser`.
- Validate điều kiện "bắt buộc nếu target backend-go" vẫn để ở tầng UI
  (`FleetProvisionWizard.tsx`), đúng như task ghi rõ — không thêm ở đây.

> **Nguồn gốc:** task này được viết lần đầu là `TASK-BE-FLEET-005` trong
> `specs/backend-go/crs/v4/fleet-provisioning/` — sai vị trí, vì nó sửa
> `frontend/`, không phải `backend-go/`. Phiên thực thi backend-go trước
> đó (2026-09-09) đã SKIP đúng đắn (không tự ý mở rộng phạm vi ra ngoài
> `backend-go/`) và ghi rõ "cần 1 agent/phiên riêng có quyền sửa
> `frontend/`". Nội dung dưới đây được chuyển nguyên trạng sang đây, cập
> nhật lại đường dẫn liên kết cho khớp vị trí mới.

---

## Mục tiêu

Thêm field `vaultSshRole` (optional) vào `FleetServerSchema` — field bắt buộc khi client dùng luồng
`backend-go`'s `BulkProvisionFleet` (`TASK-BE-FLEET-001`/`003`, cả 2 đã ✅ DONE), phân biệt với `identityFile`
cũ chỉ dùng cho path `desktop/` legacy.

**Lưu ý phạm vi:** task này KHÔNG sửa code Go (`infra-fleet-service` không parse YAML — chỉ nhận `FleetSpec`
đã parse+validate, theo đúng quyết định đã chốt ở CR-FLEET-001). Việc parse/validate `vaultSshRole` hoàn
toàn ở tầng gọi RPC (frontend/CLI).

## Files cần sửa

1. `frontend/src/shared/fleet-config-parser.ts` (MODIFY — `FleetServerSchema` thêm field)

## Nội dung — vị trí chính xác đã verify (2026-09-09)

```ts
// dòng 36-53 hiện tại:
const FleetServerSchema = z.object({
  id: z.string(),
  label: z.string(),
  host: z.string(),
  port: z.number().optional().default(22),
  username: z.string().optional(),
  identityFile: z.string().optional(), // GIỮ NGUYÊN — dùng cho path desktop/ legacy
  jumpHost: z.string().optional(),
  proxyCommand: z.string().optional(),
  relayGracePeriodSeconds: z.number().optional(),
  project: z.string().optional(),
  team: z.string().optional(),
  environment: z.enum(['development', 'staging', 'production']).optional(),
  tags: z.array(z.string()).optional(),
  repos: z.array(FleetRepoSchema).optional(),
  portForwards: z.array(FleetPortForwardSchema).optional(),
  bootstrap: FleetServerBootstrapSchema.optional(),
  // MỚI — bắt buộc khi target backend là backend-go's BulkProvisionFleet
  // (CR-FLEET-001). identityFile ở trên chỉ hợp lệ cho path desktop/
  // legacy — backend-go's domain.NewSshTarget không có field identityFile,
  // enforce Vault-only invariant (xem ssh_target.go's ErrEmptyVaultSSHRole).
  vaultSshRole: z.string().optional(),
})
```

Thêm đúng 1 dòng `vaultSshRole: z.string().optional(),` vào cuối object (trước dấu đóng `})` ở dòng 53) —
KHÔNG xoá/sửa `identityFile` (dòng 42, vẫn cần cho path `desktop/` legacy).

**Đánh dấu `@deprecated` cho `identityFile` khi dùng ở path backend-go** — thêm comment ngay tại field đó
(dòng 42), không phải xoá field:

```ts
identityFile: z.string().optional(), // @deprecated cho path backend-go (Vault-only invariant) — vẫn dùng cho path desktop/ legacy
```

## Validate ở tầng gọi RPC (không phải trong schema Zod)

Zod's `.optional()` không thể enforce "bắt buộc nếu target là backend-go" (điều kiện phụ thuộc runtime
context, không phải shape tĩnh của 1 record). Việc validate "server thiếu `vaultSshRole` sẽ bị skip nếu
target backend là backend-go" thuộc UI layer (`FleetProvisionWizard.tsx`'s bước "confirm" — CR-FLEET-001's
Changes Required, ngoài phạm vi task này vì đó là UI component, không phải schema) — task này chỉ thêm field
vào schema, không thêm logic validate điều kiện.

## Test cases cần cover

- `parseFleetConfigFromString` (tên hàm export thật, dòng 115-117: `export function
  parseFleetConfigFromString(yamlContent: string): FleetConfig { ...; return FleetConfigSchema.parse(raw) }`)
  với 1 fixture YAML có `vaultSshRole` → parse thành công, field xuất hiện đúng trong kết quả.
- Fixture YAML KHÔNG có `vaultSshRole` (chỉ có `identityFile`, như file cũ) → vẫn parse thành công
  (backward-compat, field optional).
- Fixture YAML có CẢ `identityFile` VÀ `vaultSshRole` → parse thành công, cả 2 field cùng tồn tại trong kết
  quả (không loại trừ nhau ở tầng schema — loại trừ chỉ xảy ra ở tầng UI/business logic khi chọn target).

## Verify

```bash
cd frontend && npx vitest run src/shared/fleet-config-parser.test.ts   # xác nhận tên file test thật trước khi chạy — có thể chưa tồn tại, tạo mới nếu cần
npx tsc --noEmit -p . 2>&1 | grep fleet-config-parser  # xác nhận không có lỗi type mới
```

## gitnexus

`fleet-config-parser.ts` là TypeScript — nếu GitNexus đã index `frontend/`, chạy
`codegraph_explore "FleetServerSchema"` để xác nhận mọi call site dùng
`FleetServerSchema`/`FleetConfig` type trước khi thêm field (thêm field optional mới hiếm khi phá caller
hiện có, nhưng xác nhận không có nơi nào destructure exact-shape check số field).

## Blocking

Không task `backend-go` nào phụ thuộc trực tiếp file này để build — nhưng đây là điều kiện để bất kỳ ai
(UI, CLI, hay test integration) build được `FleetSpecServer` hợp lệ có `VaultSSHRole` gửi tới
`BulkProvisionFleet` (`TASK-BE-FLEET-001`) qua RPC (`TASK-BE-FLEET-003`). Cũng là điều kiện round-trip đầy
đủ cho `TASK-BE-FLEET-013` (`ExportFleetDefinitionYaml`) — task đó đã ✅ DONE nhưng ghi nhận gap "round-trip
phụ thuộc task này chưa làm" trong "Kết quả thực tế" của nó.

## Liên quan

- [CR-FLEET-001](../../../../../../docs/crs/v4/fleet-provisioning/CR-FLEET-001-bulk-provision-from-yaml.md)
- [BE-FLEET-SOL-001](../../../../../backend-go/crs/v4/fleet-provisioning/solutions/BE-FLEET-SOL-001-bulk-provision-from-yaml.md)
- [TASK-BE-FLEET-013](../../../../../backend-go/crs/v4/fleet-provisioning/tasks/TASK-BE-FLEET-013-export-fleet-definition-yaml.md) — round-trip depends on this
