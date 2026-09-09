# TODO — việc lớn còn treo

Danh sách các hạng mục lớn đã được khảo sát/lên kế hoạch nhưng **chưa
triển khai** (hoặc đã triển khai một phần rồi bị revert), không thuộc phạm
vi các fix đang làm trong phiên hiện tại. Chi tiết đầy đủ từng phase nằm ở
plan file làm việc (không nằm trong repo) — file này chỉ tóm tắt để tra
cứu nhanh và không bị quên.

Xem thêm [`README.md`](./README.md) trong cùng thư mục — danh sách
`BACKLOG-XXX.md` có cấu trúc hơn (mỗi mục 1 file, format tiếng Anh, style
audit kỹ thuật), độc lập với danh sách này.

## 1. Phase 5 — Port Ephemeral VM Runtime (F18) sang Dev Server Agent

**Trạng thái**: mới khảo sát kiến trúc, chưa viết code.

ADR-017/018 xác định Ephemeral VM Runtime thuộc Layer A2 (Execution) của
Dev Server Agent (Data Plane), backend-go chỉ quyết định chứ không thực
thi. Client hiện có (`runtime-ephemeral-vm-client.ts`) nhắm vào cơ chế
pairing/"Remote Servers" cũ (`window.api.runtimeEnvironments`), **không**
tái dùng được cho đường dẫn connectionId/SSH dev-server-agent — cần xây
đường dây mới từ đầu.

Đã có sẵn cơ chế passthrough chung (`infra-fleet-service`'s
`Relay`/`RelayByDevServer` + `devserveragent.Client.Exec`), nên bản đầu
tiên không cần proto/gRPC message mới — chỉ cần:
- `agent/src/relay/vm-recipe-handler.ts` (tái dùng pattern
  `handleShellExec` đã có ở workflow-service's shell step)
- wscompat channel mới (`channels_ephemeral_vm.go`) gọi `Relay`
- nhánh mới trong `runtime-ephemeral-vm-client.ts` cho repo có connectionId

**Câu hỏi thiết kế chưa chốt** (phải quyết trước khi code):
1. Connection type `orca-server` giả định có Electron desktop tương tác để
   pair — vô nghĩa ở môi trường headless, cần thiết kế lại hoặc bỏ.
2. Connection type `ssh` (VM nằm trên máy thứ ba, không phải chính
   dev-server) — agent chưa có tương đương.
3. Lưu trữ runtime-record: desktop dùng file JSON local, agent chưa có
   Postgres/SQLite riêng theo project.
4. Recipe source phía agent (đọc `orca.yaml` từ worktree đã checkout?) —
   cần xác nhận.
5. Bảo mật: recipe là shell script chạy trên dev-server **dùng chung** —
   cùng mức rủi ro với `shell` step của workflow-service (không phải rủi
   ro mới), nhưng nên xác nhận rõ trước khi mở cho recipe tuỳ ý.

## 2. Phase 9 — Rename "Project" (sidebar) → "RepoGroup" (ĐÃ REVERT)

**Trạng thái**: một phần đã triển khai và deploy live, sau đó **revert
toàn bộ** theo quyết định của user — không thử lại nếu chưa đọc lại Phase
10 (Context bên dưới) trước, vì hướng đi đúng có thể là sửa data model
(Phase 10) chứ không phải đổi tên.

Vấn đề: app hiển thị "Projects" ở 2 chỗ không liên quan nhau — sidebar
trái (nhóm client-only theo git identity, `frontend/src/shared/types.ts`'s
`Project`, không phải row DB) và Project Workspace's switcher (OrcaProject
thật, có membership/RBAC). User quyết định đổi tên khái niệm sidebar thành
`RepoGroup` trong toàn bộ `frontend/` để tránh nhầm lẫn.

**Lý do phức tạp**: từ "Project" bị dùng chồng chéo cho 4 khái niệm khác
nhau trong cùng codebase (RepoGroup cần đổi tên / OrcaProject thật / khái
niệm `ProjectGroup` — cây thư mục tổ chức không liên quan / các type tích
hợp bên thứ 3 như JiraProject, LinearProject, GitHubProjectSettings...).
200+ vị trí trong ~140 file non-test + ~66 file test dưới `frontend/src/`.

## 3. Phase 10 — Chuyển `dev_server_id` từ Project sang Repo

**Trạng thái**: đã khảo sát kỹ (schema/blast-radius/UI), **chưa viết
code**.

Gốc rễ của rất nhiều bug đã gặp trong phiên (aiops-v3 sai dev server, repo
trùng lặp, "AI-Ops không có dev server", nhầm lẫn RebindDevServer,
WORKTREE_DETECT_FAILED khi repo thật ở host khác host của project) đều bắt
nguồn từ: `dev_server_id` nằm trên `project.projects` (1 cái/OrcaProject),
KHÔNG nằm trên `project.repos` — "repo này ở host nào" chỉ được suy ra từ
project cha, không tự thân nói được.

**Hướng sửa đã thống nhất với user**:
1. Một "Project" (khái niệm sidebar cũ) nên là cặp 1-1 (dev-server, repo)
   rõ ràng, đặt tên `{dev-server}.{repo-name}`.
2. OrcaProject thật (có membership) **không** còn giữ 1 `dev_server_id`
   duy nhất nữa — nó trở thành **tập hợp** các cặp (dev-server, repo) này,
   nên chia sẻ một OrcaProject sẽ tự nhiên chia sẻ nhiều repo trên nhiều
   host khác nhau, thay vì ép mọi repo thêm vào project phải nằm trên 1
   host cố định của project đó.

**Đánh đổi cần biết rõ**: tính năng cũ "cùng 1 repo checkout trên ≥2 host
gộp thành 1 card" (`project-host-setup-projection.test.ts:88-347`,
"N hosts configured" trong `new-workspace-project-options.ts`) sẽ **mất
đi** — cặp (dev-server, repo) không thể gộp qua nhiều host theo định
nghĩa. Nhiều khả năng đây là hướng đúng (đã gây nhiều nhầm lẫn thực tế),
nhưng là thay đổi tính năng thật, không phải thuần bugfix.

**Phân kỳ đề xuất**: backend trước (10-1, 10-2 — đơn giản hoá
git-gateway-service, KHÔNG cần đổi logic vì `dispatchExecutorForRepo` đã
đọc `DevServerID` như thể là property của repo rồi, chỉ đang lấy gián tiếp
qua project), frontend sau (10-3 — thay đổi lớn hơn, bỏ tính năng gộp
multi-host, sửa ~7 test block, ảnh hưởng 5+ UI surface).

### Việc dở dang liên quan (đã fix một phần, còn sót)

- `worktree-list-groups.ts`'s `getMixedHostContextLabels`/
  `hostContextLabel`/`hostLabelById` (~dòng 655-690, 1135-1155) hiện là
  dead code (một project group không thể còn span >1 host sau khi đổi
  identity-key) nhưng chưa xoá — file 900+ dòng có fixture test còn nuôi
  dữ liệu multi-repo giả, cần dọn riêng để tránh rush.
- Format hiển thị `{dev-server}.{repo-name}` chưa được bake vào
  `Project.displayName` (cần thread `state.devServers` vào module thuần
  `project-host-setup-projection.ts` — thay đổi kiến trúc lớn hơn). Hiện
  `Project.devServerId` đã được expose trên type để renderer nào có store
  access tự ghép `${displayName}` + tên dev server nếu cần.
- `resolvePortableEphemeralVmProjectId`
  (`frontend/src/renderer/src/lib/ephemeral-vm-worktree-creation.ts`,
  ~dòng 167-177) — điều kiện `getProjectIdentityKey(repo).startsWith('github:')`
  không bao giờ còn đúng nữa (luôn rơi xuống
  `request.ephemeralVmRecipe.projectId`) — dead code, chưa dọn.

## 4. Dead-code / UX nhỏ khác

- **`NonGitFolderDialog.tsx`** — chưa có nút "Initialize as Git repo" đối
  xứng với nút đã thêm ở WorktreeCreationPanel (cho luồng
  worktree-creation-failure). Cần quyết định thiết kế trước: dialog này
  dùng semantics khác (`addNonGitFolder`/`addRuntimeRepoRemote` với
  `kind: 'folder'`), không giống `repo.create`/InitRepo RPC — không phải
  copy-paste đơn giản.
- **`RepositoryHooksSection.tsx`** — EnvVarChips (`ORCA_ROOT_PATH`,
  `$ORCA_WORKTREE_PATH`, `$ORCA_WORKSPACE_NAME`...) hiện chỉ hiển thị dạng
  chip, chưa có tính năng click-để-chèn vào ô input Setup Script. Phát
  hiện trong lúc điều tra bug Setup Script — là UX gap thật nhưng tách
  biệt với bug BaseRefDefault/CheckHooks (đã fix ở Phase 11).

## 5. Frontend gaps theo Feature ↔ Business Logic Mapping

**Trạng thái**: chỉ mới đối chiếu tài liệu (`feature-business-logic-mapping.md`,
mục 4-5), **chưa verify lại với code** — khác với các mục BACKLOG-XXX (đã
grep/trace tận gốc). Danh sách dưới đây phản ánh coverage tự báo cáo trong
tài liệu, không phải kết luận kỹ thuật đã xác nhận. Cần một lượt kiểm tra
GitNexus/CodeGraph trước khi biến bất kỳ mục nào thành BACKLOG-XXX thật.

**Feature có coverage nghiệp vụ chưa đầy đủ** (mục 4 của tài liệu):
- F27 Fleet Health Monitoring — thiếu BL-FLEET-04 (Onboarding Wizard)
- F08 Annotate AI Diffs — thiếu BL-CR-04, BL-CR-05 (3/5 nghiệp vụ Code Review)
- F23 Multi-User Auth — chỉ 2/5 BL-AUTH-*
- F25 Admin Panel — chỉ 2/5 BL-AUTH-*
- F28 Dev Server Onboarding — chỉ 1/4 Fleet Management, phần còn lại mới ở mức "Supports"
- F24 Per-User Sandbox — chỉ 1 nghiệp vụ implement (isolation)
- F11 Notifications — thuần supporting, chưa có implement chính
- F15 Computer Use — "emerging", 0 nghiệp vụ implement chính thức
- F26 Multi-Database — infrastructure thuần, không map BL cụ thể

**5 gap được tài liệu đánh dấu rõ** (mục 5 — "Cần spec mở rộng"):
- BL-WT-04 So sánh Worktrees (F01, F08) — cần UI spec cho compare view
- BL-AG-04 Switch Account (F04) — cần UI spec cho account switcher
- BL-MB-02 Push Notification offline (F03) — cần spec offline buffering
- BL-AT-03 Event Trigger (F14, F09) — cần spec event bus
- BL-AUTH-02 Session renewal (F22, F23) — chưa chốt TTL auto-renew vs explicit renew

---

*File này được cập nhật thủ công khi có yêu cầu rà soát — không tự động
đồng bộ với plan file làm việc. Khi bắt đầu triển khai một mục, xoá mục đó
khỏi đây và (nếu cần) mở lại plan chi tiết tương ứng.*
