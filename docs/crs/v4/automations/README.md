# Automations (F14) — Change Requests (v4)

> **Bối cảnh:** F14 ([`docs/features/F14-automations.md`](../../../features/F14-automations.md))
> mô tả một hệ thống automation nhẹ: trigger (cron / manual / event) →
> chuỗi **nhiều action có thứ tự** (`create_worktree` → `run_agent` →
> `commit_push` → `create_pr` → `send_notification` → `run_script`).
> Audit trực tiếp mã nguồn (2026-09-09) cho thấy F14 **không phải "chưa
> xây"** — ngược lại, có **3 implementation song song, không liên thông**
> ở tầng server, cộng thêm UI renderer rất đầy đủ
> (`frontend/src/renderer/src/components/automations/`, 30+ file,
> `AutomationsPage.tsx` 2991 dòng) — nhưng cả 3 backend đều dừng ở model
> "automation = 1 prompt / 1 step", không có action chain nào giống spec
> YAML. 8 CR dưới đây là kế hoạch đưa F14 tới đúng scope spec, ưu tiên
> **hợp nhất trước khi mở rộng** — thêm action executor vào 3 bản
> triplicate cùng lúc sẽ nhân ba effort và nhân ba lỗi.

| CR | Vấn đề | Đề xuất | Tầng | Priority | Status |
|----|--------|---------|------|----------|--------|
| [CR-AUTO-001](./CR-AUTO-001-consolidate-execution-backend.md) | ~~3 bản song song, renderer không bao giờ gọi backend-go~~ **[Sửa 2026-09-09]** renderer đã tự route `{kind:'environment'}` (đã pair runtime environment) sang `backend-go` qua `callRuntimeRpc`/`automation.*` wscompat channel — chỉ `{kind:'local'}` dùng scheduler Electron/Node cục bộ, đúng thiết kế nhất quán với `ephemeralVm` | Xác nhận kiến trúc 2 trục (deployment target × pairing) hiện tại là đúng ý, giữ nguyên `{kind:'local'}` cục bộ; chỉ cần đóng 2 gap nhỏ (xem solution) | `frontend` + `backend-go` | P2 (hạ từ P0 sau khi sửa) | 🔲 Proposed — scope đã thu hẹp |
| [CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md) | `Automation` (TS) chỉ có 1 `prompt`/`agentId`; `Automation` (Go proto) chỉ có 1 `step_type`/`step_config_json` — không model nào có `actions[]` có thứ tự như spec YAML | Thêm `actions: AutomationAction[]` (ordered, mỗi action có `type`/`config`/`continueOnFailure`) vào backend canonical đã chọn ở CR-AUTO-001; giữ tương thích ngược với automation 1-step hiện có | tầng đã chọn ở CR-AUTO-001 | **P0** | 🔲 Proposed |
| [CR-AUTO-003](./CR-AUTO-003-action-executors-commit-pr.md) | Không executor nào cho action `commit_push`/`create_pr` dù logic commit/push/tạo PR đã có sẵn ở nơi khác (`dev-server-git-provider.ts:359`, `ssh-git-provider.ts:163`, `git.push` RPC, `scm-integration-service`'s `createPullRequest`) | Thêm 2 action executor, **tái dùng nguyên xi** các hàm/RPC trên, không viết lại logic git/PR | tầng đã chọn ở CR-AUTO-001 | P1 | 🔲 Proposed |
| [CR-AUTO-004](./CR-AUTO-004-action-executors-script-notification.md) | Không executor nào cho action `run_script`/`send_notification`; `run_script` gần với `precheck-runner.ts` (chạy command local/SSH có timeout, capture output) nhưng đó là pre-check, không phải post-action; `send_notification` chưa có service gửi notification nào ở `desktop/src/main` (mobile-push là subsystem riêng — F11) | Tổng quát hoá `precheck-runner.ts`'s shape thành 1 action executor `run_script` dùng lại được; thêm `send_notification` executor nối vào subsystem notification hiện có (F11) | tầng đã chọn ở CR-AUTO-001 | P1 | 🔲 Proposed |
| [CR-AUTO-005](./CR-AUTO-005-real-event-triggers.md) | Spec's **Event trigger** ("khi agent kết thúc, khi PR merged") không tồn tại thật: `AutomationRunTrigger` (TS) chỉ có `'scheduled' \| 'manual'`; file duy nhất từng thử làm việc này — `desktop/src/main/automations/AutomationEventBridge.ts` — **không hề được instantiate ở đâu trong sản phẩm** (`grep "new AutomationEventBridge"` chỉ khớp doc-comment ví dụ của chính nó) và gọi `automationService.dispatchAutomation(...)` — method không tồn tại trên `AutomationService`, sẽ throw nếu chạy | Xoá/khoanh vùng `AutomationEventBridge.ts` là dead code; xây event trigger thật trên nền `backend-go`'s `HandleExternalTrigger` (đã có RPC thật, idempotency qua `request_id`) — nối các sự kiện nội bộ (agent hoàn thành, PR merged) gọi vào đó, đồng thời đóng lỗ hổng auth webhook | `backend-go` + nơi phát sự kiện nội bộ (`desktop`/`agent`) | P1 | 🔲 Proposed |
| [CR-AUTO-006](./CR-AUTO-006-worktree-cleanup-service.md) | `desktop/src/main/automations/WorktreeCleanupService.ts` là dead code — không nơi nào trong sản phẩm khởi tạo nó (cùng dạng "chỉ khớp doc-comment ví dụ" như CR-AUTO-005) dù logic cleanup (age/status filter, an toàn qua `git status --porcelain`, `git worktree remove --force`) trông hợp lệ và gọi đúng RPC thật (`git.exec`, `worktree.list`) | Quyết định: wire thật thành 1 automation action/scheduled job, hoặc xoá nếu không còn nhu cầu sản phẩm — không để dead code tồn tại vô thời hạn | `desktop` | P2 | 🔲 Proposed |
| [CR-AUTO-007](./CR-AUTO-007-retention-scheduler-hardening.md) | Retention "N run cuối" không cấu hình được (`MAX_AUTOMATION_RUNS_PER_AUTOMATION = 100` hardcode ở `automation-run-retention.ts:3`); `backend-go` chưa enforce retention nào, chưa có timeout chạy automation (BUG-AT-02: không giới hạn 2 giờ), chưa có concurrency guard giữa manual run và scheduled run cùng lúc | Thêm retention cấu hình theo automation ở TS side; thêm retention enforcement + run timeout + concurrency guard ở `backend-go`'s scheduler/repository | tầng đã chọn ở CR-AUTO-001 (chủ yếu `backend-go`) | P2 | 🔲 Proposed |
| [CR-AUTO-008](./CR-AUTO-008-backend-go-rest-parity-webhook-auth.md) | `backend-go`'s REST gateway chỉ mount `create`/`runNow`/`listRuns`/`trigger` (`automation_routes.go:23-28`) — thiếu REST cho `ListAutomations`/`UpdateAutomation`/`DeleteAutomation` (chỉ gọi được qua gRPC/WS); `HandleExternalTrigger`'s `payload_json` không có auth (README tự nhận: "any caller inside tenant trust boundary can fire external triggers"); `automation-service/README.md:188` nói sai — claim thiếu 3 RPC đó dù đã có từ commit `3df9da8b1` | Thêm REST route còn thiếu; thêm shared-secret/signature auth cho external trigger endpoint; sửa README lỗi thời | `backend-go` | P2 | 🔲 Proposed |

## Phát hiện mới (audit 2026-09-09, chưa từng ghi nhận đầy đủ trước đây)

1. **Không phải 2, mà là 3 bản automation service song song**, chưa từng
   được so sánh cạnh nhau trong 1 tài liệu duy nhất trước audit này:
   - `desktop/src/main/automations/service.ts` (`AutomationService`, tick
     60s, `DEFAULT_TICK_MS`) — Electron main process, lưu file-based
     `Store`, dispatch qua `webContents.send('automations:dispatchRequested', …)`
     hoặc `headlessDispatcher`.
   - `backend/src/main/automations/` — gần như copy TS y hệt, nhưng lưu
     Postgres qua `pg-automation-store.ts` (Node "server mode",
     `ORCA_MULTI_USER=1`, ADR-021, commit `413f5c8da`).
   - `backend-go/services/automation-service` — Go, Postgres schema
     riêng (`migrations/0001_init.up.sql`, `0002_scheduler_columns.up.sql`),
     scheduler riêng (`internal/adapter/scheduler/ticker.go`), model
     **1 step** (`step_type`/`step_config_json`, tái dùng
     `workflow-service`'s `StepType` enum), thực thi qua gRPC thật tới
     `workflow-service.ExecuteAdHocStep`.
   Renderer's `AutomationsPage.tsx` (qua `automation-host-client.ts` →
   `runtime-rpc-client.ts`) **chỉ nói chuyện với 2 bản đầu** — backend-go's
   automation-service tồn tại, có test e2e thật (`run_now_e2e_test.go`,
   391 dòng), nhưng không UI nào trong sản phẩm gọi tới nó hôm nay.
2. **Event trigger là dead code, không phải "đã fix" như
   `specs/backend/bugs/automation/BUG-BE-AT-001-...md` claim.**
   `AutomationEventBridge.ts:145` gọi
   `this.automationService.dispatchAutomation(automation.id, …)` —
   `AutomationService` không có method này (chỉ có `runNow`,
   `runPrecheck`, `markDispatchResult`, và các private
   `evaluateDueRuns`/`evaluateAutomation`/`requestDispatch`). File cũng
   đọc `a.triggerType` (dòng 140) qua `as unknown as {...}` cast tới 1
   shape không khớp `Automation` thật. File compile qua được nhờ cast,
   nhưng sẽ throw runtime nếu có ai gọi tới — và không ai gọi, vì
   `grep -rn "new AutomationEventBridge"` toàn repo chỉ khớp chính
   doc-comment ví dụ của nó (dòng 13).
3. **`WorktreeCleanupService.ts` cùng dạng dead code** — cùng pattern
   "chỉ khớp doc-comment ví dụ của chính nó", nhưng khác
   `AutomationEventBridge`, logic bên trong (age/status filter, safety
   check qua `git status --porcelain`, gọi `git.exec`/`worktree.list` —
   các RPC có thật) trông sound, chỉ đơn giản chưa từng được composition
   root nào khởi tạo.
4. **`backend-go/services/automation-service/README.md:188` tự mâu
   thuẫn với chính code cùng thư mục.** README claim "No
   UpdateAutomation/DeleteAutomation/GetAutomation/ListAutomations RPCs"
   — nhưng `automation.proto:27-29` và `server.go` (dòng 115, 131, 171)
   đã implement 3 trong 4 RPC đó từ commit `3df9da8b1` (2026-08-25).
   README cuối cùng sửa ở `0e7092d18` (2026-08-18), tức là **trước** khi
   3 RPC được thêm — chỉ đơn giản chưa update lại.

## Nguyên tắc thiết kế xuyên suốt

1. **Hợp nhất trước, mở rộng sau.** CR-AUTO-002..008 đều viết trên nền
   "1 backend canonical" mà CR-AUTO-001 chọn — không action executor nào
   được thêm vào cả 3 bản triplicate cùng lúc. Nếu CR-AUTO-001 chưa
   merge, các CR sau tạm hoãn theo đúng thứ tự ở dưới.
2. **Tái dùng logic đã có, không viết lại.** commit/push
   (`dev-server-git-provider.ts:359`, `ssh-git-provider.ts:163`,
   `git.push` RPC), tạo PR (`scm-integration-service`'s
   `createPullRequest`), tạo worktree
   (`OrcaRuntimeService.createManagedWorktree` qua
   `headless-workspace-create.ts`) đều đã có, đã test — action executor
   chỉ là lớp mỏng gọi vào chúng theo đúng khuôn `agent-cli-handler.ts`/
   `precheck-runner.ts` đã dùng ở nơi khác trong repo.
3. **Không giữ dead code vô thời hạn.** `AutomationEventBridge.ts`
   (CR-AUTO-005) và `WorktreeCleanupService.ts` (CR-AUTO-006) mỗi cái
   phải kết thúc ở 1 trong 2 trạng thái rõ ràng: wire thật hoặc xoá —
   không CR nào được phép để nguyên hiện trạng "trông như đã xong nhưng
   không chạy".
4. **SSH/remote-host là use case bắt buộc phải cân nhắc** (theo
   AGENTS.md) — đây là lý do chính CR-AUTO-001 nghiêng về `backend-go`
   làm canonical: scheduler sống trong Electron main process
   (`service.ts`) dừng theo vòng đời app, không phù hợp automation cần
   chạy khi user không mở Orca trên máy đó; `backend-go`'s Postgres-backed
   ticker không có giới hạn này. `run-target-resolution.ts:41-50` hiện
   **chặn cứng** automation nhắm remote/runtime-environment — quyết định
   này cần xem lại cùng lúc với CR-AUTO-001, không tự động "mở khoá".

## Thứ tự thực thi & phụ thuộc

```
CR-AUTO-001 → nền tảng, phải làm/quyết định trước tiên — chọn backend
              canonical. Không phải rewrite lớn ngay (có thể là "backend-go
              là canonical cho automation MỚI, automation cũ trên
              Electron/Node tiếp tục chạy, có migration path"), nhưng
              quyết định phải chốt trước khi CR-AUTO-002 bắt đầu
CR-AUTO-002 → phụ thuộc CỨNG vào CR-AUTO-001 (cần biết model actions[]
              thêm vào đâu)
CR-AUTO-003,
CR-AUTO-004 → phụ thuộc CỨNG vào CR-AUTO-002 (cần actions[] tồn tại để
              có chỗ gắn executor); 003 và 004 độc lập với nhau, làm
              song song được
CR-AUTO-005 → độc lập kỹ thuật với 002/003/004 (event trigger không cần
              action chain để có giá trị — 1 automation 1-step vẫn
              hưởng lợi từ trigger event thật), nhưng nên làm sau
              CR-AUTO-001 vì cần biết gọi HandleExternalTrigger của
              backend nào
CR-AUTO-006 → hoàn toàn độc lập, không phụ thuộc CR nào khác trong nhóm
              này — có thể làm bất cứ lúc nào
CR-AUTO-007,
CR-AUTO-008 → độc lập với 002-006, chủ yếu backend-go hardening — làm
              song song được, không chặn hay bị chặn bởi nhóm action-chain
```

## Rủi ro chung cần lưu ý trước khi triển khai bất kỳ CR nào

- **CR-AUTO-001 là quyết định kiến trúc, không phải chỉ code.** Trước khi
  viết bất kỳ dòng code nào cho CR-AUTO-002 trở đi, cần alignment với
  team về việc có migrate automation cũ (Electron/Node) sang backend-go
  hay không, và lộ trình deprecate 2 bản kia — nếu không, CR-AUTO-002..008
  sẽ tiếp tục nhân bản effort giống hiện trạng.
- **`run_script` action chạy shell command tuỳ ý** — cùng class rủi ro
  với `ephemeralVm`'s `vm.exec`/`vm.provision` (xem
  [`docs/crs/v3/ephemeral-vm/README.md`](../../v3/ephemeral-vm/README.md)) —
  kế thừa toàn bộ môi trường/credentials của máy thực thi. CR-AUTO-004
  không được mở rộng blast radius này (chỉ hiện thực hoá đúng behavior
  spec đã khai báo), nhưng cần review bảo mật riêng, đặc biệt nếu action
  này chạy được trên remote/SSH target.
- **`HandleExternalTrigger`'s auth gap (CR-AUTO-008) là lỗ hổng bảo mật
  thật đang tồn tại hôm nay**, không phải rủi ro tương lai — bất kỳ caller
  nào trong tenant trust boundary hiện tại có thể trigger automation của
  người khác trong cùng tenant. Ưu tiên đóng gap này sớm dù priority ghi
  P2 (P2 vì scope hẹp/nhanh, không phải vì ít nghiêm trọng).
