# FE-TASK-AUTO-001: Badge "chạy ở đâu" cho automation

**Solution:** [FE-AUTO-SOL-001](../solutions/FE-AUTO-SOL-001-confirm-routing.md) | **CR:** CR-AUTO-001
**Depends on:** Không
**Status:** ✅ DONE (2026-09-09) — Detail panel + list row cùng xong

---

## Mục tiêu

Hiển thị rõ automation đang thuộc "Local" hay tên runtime environment cụ
thể — dùng `getAutomationOwnerTarget` đã có, không tính toán lại target
theo cách khác.

## Files cần sửa

1. `frontend/src/renderer/src/components/automations/AutomationDetail.tsx` (MODIFY)
2. Danh sách automation (row trong `AutomationsPage.tsx` hoặc file con nếu đã tách) (MODIFY)

## Bước 1 — Khảo sát nguồn tên runtime environment

Tìm store/slice đã có danh sách runtime environment kèm tên hiển thị
(không chỉ id) — tái dùng, không fetch riêng.

## Nội dung

```tsx
const target = getAutomationOwnerTarget(automation)
const label = target.kind === 'local' ? 'Local' : getRuntimeEnvironmentName(target.environmentId) // tên hàm tuỳ store thật
```
Render `<Badge>{label}</Badge>` cạnh tên automation.

## Test cases cần cover

- Automation `runContext.hostId` trỏ local → badge "Local".
- Automation `runContext.hostId` trỏ 1 runtime environment → badge đúng tên environment đó.
- Runtime environment không còn tồn tại (đã bị xoá) → badge fallback hợp lý (không crash).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/automations/AutomationDetail.test.tsx
npx tsc --noEmit
```

## gitnexus

`impact({target: "getAutomationOwnerTarget", direction: "upstream"})`
trước khi dùng ở thêm 1 call site mới.

---

## 🟡 Kết quả thực tế (2026-09-09) — PARTIAL

**Lệch so với sketch gốc**: dùng `hostLabelById`/`getExecutionHostLabel`
(`../../../../shared/execution-host.ts`) thay vì `getAutomationOwnerTarget`
— lý do: `AutomationDetail.tsx` đã sẵn nhận prop `hostLabelById:
ReadonlyMap<string,string>` và dùng đúng pattern này cho
`sourceDisplay` (dòng 134, `getAutomationSourceDisplay(automation.sourceContext,
hostLabelById)`) — tái dùng cùng 1 map thay vì tính lại target qua
`getAutomationOwnerTarget` (hàm đó trả `{kind:'local'}`/`{kind:'environment',
environmentId}`, không trực tiếp cho tên hiển thị, vẫn phải tra map để
có tên). `hostLabelById` được build ở `AutomationsPage.tsx:962-973`,
xác nhận map `runtime:<id>` → `environment.name` (tên thật, không phải
raw id) và `local` → `getLocalExecutionHostLabel()` — khớp đúng "Bước 1"
yêu cầu, không cần fetch riêng.

- Thêm badge (dùng `Tooltip` + `Badge` đã import sẵn trong file) cạnh
  badge Enabled/Paused trong `AutomationDetail.tsx`.
- **Chưa làm**: badge tương tự trong list row (`AutomationsPage.tsx`,
  2991 dòng) — file lớn, nhiều logic layout phức tạp quanh khu vực row
  (dòng 2400-2520); không rush edit trong task này để tránh regression
  layout không kiểm soát được bằng test hiện có (không có test harness
  render cho khu vực đó). Đánh dấu PARTIAL, để lại cho lần làm sau nếu
  cần.
- Fallback khi runtime environment đã bị xoá: `getExecutionHostLabel`
  fallback về `parsed.environmentId` (raw id) khi không có trong
  `hostLabelById` — không crash, nhưng hiển thị id thô thay vì tên đẹp
  (chấp nhận được, giống hành vi `sourceDisplay` đã có).

**Verify**: `npx tsc --noEmit` — 0 lỗi. `npx oxlint
src/renderer/src/components/automations/AutomationDetail.tsx` — 0 lỗi.
Không có test file `AutomationDetail.test.tsx`/`AutomationsPage.test.tsx`
nào tồn tại để chạy render-test (gitnexus xác nhận
`AutomationDetail`'s caller duy nhất là `AutomationsPage`, không phá
API/props hiện có — chỉ thêm field dùng nội bộ, không đổi
`AutomationDetailProps`).

**Files đã sửa:**
- `frontend/src/renderer/src/components/automations/AutomationDetail.tsx` (MODIFY)

## ✅ Kết quả thực tế (2026-09-09, tiếp theo) — list row DONE

**Khảo sát row hiện tại**: `AutomationsPage.tsx` (trước khi sửa: 2991
dòng, có sẵn `/* eslint-disable max-lines */` từ trước — không phải do
task này thêm, không nằm trong `config/max-lines-baseline.txt`, là nợ kỹ
thuật có sẵn ngoài phạm vi task). Row automation (trong `automations.map`,
khoảng dòng 2396-2544 lúc khảo sát) là 1 `<ContextMenu>` + `<button>`
grid 2 cột: cột trái (tên + dot enabled/disabled, schedule, dòng meta
"repo / workspace · agent", usage text), cột phải (Clock icon + next-run,
`max-w-28`). **Phát hiện quan trọng**: khác với giả định ban đầu của
task, row này KHÔNG dùng component `Badge` cho status/enabled — chỉ có 1
dot tròn màu (`bg-foreground`/`bg-muted-foreground/40`) cho
enabled/paused, không có `<Badge>` JSX nào trong toàn bộ row (xác nhận
qua grep — `Badge` chỉ xuất hiện như `import type` cho 1 type signature
khác, không render). Vì vậy badge "chạy ở đâu" mới thêm là `<Badge>` JSX
ĐẦU TIÊN trong row này, nhưng vẫn dùng đúng styling primitive
(`variant="outline"` + `Tooltip`) giống hệt `AutomationDetail.tsx`.

**Tách component**: đúng như task gợi ý, tách row ra
`AutomationListRow.tsx` (164 dòng) — lý do kép: (1) làm
render-test được mà không cần mount toàn bộ `AutomationsPage` (state
management khổng lồ, hàng chục hook), (2) tránh tăng thêm dòng cho
`AutomationsPage.tsx` vốn đã vượt giới hạn 400 dòng/`.tsx` (dùng
eslint-disable có sẵn, không phải per-task exception). Sau khi tách,
`AutomationsPage.tsx` còn 2900 dòng (giảm, không tăng) — logic tính toán
(`automationRepo`, `workspaceLabel`, `usageText`, `nextRunLabel`,
`scheduleLabel`, `automationRunAvailability`) vẫn ở lại component cha,
chỉ JSX + handler wiring chuyển qua component con qua props (bao gồm
`hostLabelById` lấy từ biến đã có sẵn ở `AutomationsPage.tsx:962-973`,
không tính lại). Cũng xoá theo import `RepoBadgeLabel` (chỉ còn dùng bên
trong `AutomationListRow.tsx`) — không còn dùng trong
`AutomationsPage.tsx` nữa, oxlint sẽ báo unused nếu để lại.

**Badge đặt ở đâu**: chèn vào dòng meta có sẵn (repo / workspace ·
agent), thêm `· <Badge variant="outline">{runHostLabel}</Badge>` +
`Tooltip` sau agent — tái dùng đúng chỗ đã xử lý nhiều item
truncate/shrink-0 trên 1 dòng flex (đã có tiền lệ ổn định trong chính
file này, cả ở external-automation row tương tự), thay vì chèn vào dòng
tên (rủi ro chèn ép tên automation bị truncate quá sớm trong sidebar
hẹp) hoặc cột phải `max-w-28` (quá hẹp cho tên environment dài).

**Test render thêm mới** (blocker thật của lần trước, không phải
nice-to-have): `AutomationListRow.test.tsx` (163 dòng), 4 case, dùng
`createRoot`/`act` + mock `@/components/ui/tooltip` (pattern giống
`ExternalAutomationManagers.test.tsx` đã có sẵn trong cùng thư mục):
- `renders the automation name and schedule alongside the run-host badge`
- `shows "Local" when runContext.hostId is unset (defaults to local)`
- `shows the runtime environment name from hostLabelById when the automation runs on one`
- `falls back to the raw environment id (no crash) when the runtime environment was deleted`

**Fallback môi trường đã xoá**: giống hệt `AutomationDetail.tsx` —
`hostLabelById?.get(runHostId) ?? getExecutionHostLabel(runHostId)`, và
`getExecutionHostLabel` fallback về `parsed.environmentId` (raw id) khi
không parse được hoặc không có trong map. Test case thứ 4 xác nhận không
crash và hiển thị id thô.

**gitnexus impact** (`getExecutionHostLabel`, upstream, target_uid
`Function:frontend/src/shared/execution-host.ts:getExecutionHostLabel`):
risk CRITICAL nếu SỬA hàm này (27 impacted, 11 direct callers — Vault
panel, Settings, sidebar, task-source-context-summary, v.v.). Task này
KHÔNG sửa hàm đó — chỉ thêm 1 call site mới (giống
`AutomationDetail.tsx` đã làm), nên rủi ro thực tế không áp dụng; ghi
lại để không ai nhầm là an toàn sửa `getExecutionHostLabel` tự do sau
này. `impact({target: "AutomationsPage", direction: "upstream"})` → LOW
risk (0 impacted) cho việc tách component nội bộ.

**Verify** (chạy thật trong `frontend/`, có `node_modules`):
```
npx vitest run src/renderer/src/components/automations/AutomationListRow.test.tsx
  → 1 file passed, 4 tests passed

npx oxlint src/renderer/src/components/automations/
  → exit 0, 0 lỗi/cảnh báo

npx tsc --noEmit -p .
  → exit 1, nhưng 146 dòng lỗi TOÀN BỘ đều KHÔNG liên quan tới
    AutomationListRow.tsx/AutomationsPage.tsx/AutomationListRow.test.tsx
    (grep xác nhận 0 match cho 2 tên file này) — lỗi có sẵn ở
    fleet-dashboard.tsx, ProviderForm.test.tsx, code-review/*,
    mobile-notification-settings.tsx (module thiếu do generated code/1
    session khác đang sửa song song), khớp đúng cảnh báo trong task.

npx vitest run src/renderer/src/components/automations/
  → 131/132 tests passed; 1 fail KHÔNG liên quan
    (automation-project-groups.test.ts, về logic gom nhóm project theo
    provider/repo — không đụng tới execution-host/hostLabelById/badge,
    không phải file được sửa trong task này).
```

**Files đã sửa/thêm ở lần này:**
- `frontend/src/renderer/src/components/automations/AutomationListRow.tsx` (NEW)
- `frontend/src/renderer/src/components/automations/AutomationListRow.test.tsx` (NEW)
- `frontend/src/renderer/src/components/automations/AutomationsPage.tsx` (MODIFY — dùng `AutomationListRow`, xoá import `RepoBadgeLabel` không còn dùng)
