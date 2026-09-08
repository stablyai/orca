# SOL-TASKV1-008: Dual-backend routing and Postgres compliance — see CR-FLOW-TASK-004

**Resolves:** [BUG-TASKV1-008](../BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md)
**Full solution:** [CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md)
**Status:** 🔵 Proposed — not yet implemented (per the CR's own header: "Trạng thái: 🔵 Proposed — chưa triển khai")

Giải pháp đầy đủ đã được thiết kế tại CR gốc ở trên — KHÔNG lặp lại nội dung
ở đây. Bug này (task-v1 framing) chỉ là xác nhận lại từ góc nhìn "3 hệ Task"
rằng CR-004 vẫn là kế hoạch cutover đúng, chưa triển khai (re-verified:
`deploy/prod/docker-compose.yml` still defines only the Node/SQLite
`orca-server` service; `desktop/src/main/task/task-rpc-handler.ts` and
`desktop/src/main/workflow/workflow-rpc-handler.ts` still present and
unremoved).

No dedicated `specs/backend-go/crs/v3/flow-task/solutions/BE-SOL-004-*.md`
exists yet as of this writing (only `BE-SOL-001-three-engine-execution-linkage.md`
is present in that directory, covering CR-FLOW-TASK-001, not CR-004) — this
pointer targets the CR itself directly, per this task's own fallback
instruction.

## Tóm tắt điểm chính

CR-FLOW-TASK-004 is a 4-phase cutover plan: Phase 0 freezes new RPC-contract
divergence to backend-go's shape only (no-code, immediate); Phase 1 closes
every ❌/🟡 functional gap in this very directory
(BUG-TASKV1-001..007) — its own stated acceptance gate, explicitly blocking
cutover until then ("cutover khi còn gap chức năng nghĩa là giảm chức năng
cho người dùng"); Phase 2 runs dual-read/shadow traffic against a
production-shaped staging copy for 1-2 weeks; Phase 3 flips
`deploy/prod/docker-compose.yml` from the Node `orca-server` image to
backend-go's `task`/`workflow`/`orchestration` stack; Phase 4 retires the
Node handler code after one full stable release cycle.

## Điều chỉnh/bổ sung cần lưu ý

Không có, áp dụng nguyên vẹn CR gốc. Note the CR's own explicitly
undecided risk: Desktop Electron's cutover path (bundle backend-go into the
desktop app, vs. always pointing at a remote backend-go server) is
deliberately left to a separate ADR, not resolved by CR-004 itself — this
is not a gap in CR-004's design, it is CR-004's own stated scope boundary.
