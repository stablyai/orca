# orca-scryer 迁移计划

生成时间：2026-05-10

Document boundary: this is a linked migration-plan asset. It tracks implementation
scope, status, risks, and execution order. The compact planning authority is
[orca-scryer-decision-map.md](./orca-scryer-decision-map.md); decision records
live in [docs/adr](./adr/); glossary terms live in [../CONTEXT.md](../CONTEXT.md).

## 当前工作区

- 目标工作区：`/home/ljian/wspace/orca-scryer`
- 目标项目：`orca/`，来源仓库 `https://github.com/stablyai/orca`
- 功能来源：`scryer/`，来源仓库 `https://github.com/aklos/scryer`
- GitNexus 索引结果：
  - `scryer`：3,011 个节点，4,681 条关系，61 个功能区，175 条流程
  - 当前 workspace 的 `orca`：29,012 个节点，53,419 条关系，1,144 个功能区，300 条流程

## 总结结论

建议不要把 Scryer 整个 Tauri 应用直接塞进 Orca。合理做法是：

1. 保留 Scryer 的核心模型、画布、C4 层级、source map、Scryer operation 语义、任务排序和 drift sync 逻辑。
2. 舍弃 Scryer 的 Tauri 外壳、独立桌面设置页、独立 AI provider 设置、独立 Agent 启动方式。
3. 把后端能力改写到 Orca 的 Electron/Node IPC 和 Orca 自己的 agent/tab 体系里。
4. 在 Orca 的 `New tab` 菜单里新增 `New Architecture`，打开一个原生 Orca tab，而不是外部窗口或 webview。

AI provider 边界已经明确：不迁移 Scryer 的 `scryer-suggest` provider 设置，不在 Orca 里再做一套 OpenAI/Anthropic/Ollama 配置。架构图的 AI 能力走 Orca 已有 agent 体系，例如 Codex/Claude 终端和 Orca agent hooks；Scryer 迁移部分只提供模型、Native TS operation layer、Orca-native `orca scryer ...` CLI、任务提示、source map 和 drift sync 所需的数据接口。

源码边界：Scryer 当前是 `FSL-1.1-MIT`，Orca 是 `MIT`。本迁移不直接复制 upstream Scryer 实现源码进 Orca 产品运行时；采用“迁移功能语义并在 Orca 内重新实现代码”的路径。upstream Scryer 仍作为行为、schema、状态转换和 parity test 参考。

第二阶段按“前端交互 -> 前端模型状态 -> IPC/后端持久化 -> CLI/agent 外部改写 -> 前端重新理解状态”的完整链路迁移，而不是只补 UI 按钮。详细 UML 对比、时序图、状态机和细粒度完成情况见：

- `docs/orca-scryer-uml-gap-analysis.md`

## 当前状态（#36 release gate 后）

当前完成的是稳定 Architecture product slice，而不是 full Scryer
operation parity。Native Scryer Engine 已有 33 个 operation id 的 catalog
contract、schema、policy 和 upstream anchor；其中 Architecture 产品主路径需要的
operation 已有 executor 并经过 focused verification。#30 审计确认默认模型
产品主链路真实打通；#36 已把零 partial release gate 的当前 slice 缺口补齐，详见
`docs/orca-scryer-architecture-slice-audit.md`。#31 已补齐 read/query/rules/codebase
read surface executor、CLI dispatch、no-write 和 ownership gate。其余 7 个 operation
目前仍是 catalog-only/stub，会落到 `unimplemented(...)`，不能被文档称为已迁移完成。

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| Operation catalog contract | 完成 | 33 个 operation id 已有 catalog row、policy、schema 和 upstream anchor。 |
| Architecture executable slice | 已实现，release gate 通过 | `model.read/set/validate`、`plan.pending/fold`、node/link/group/source/intent add、`drift.get/reconcile` 等产品主路径 operation 已有 executor；#36 已补当前 release-critical 覆盖缺口。 |
| #26-#29 product integration | 完成 | legacy semantic owners、`ScryerEditSessionController` + Completion Gate、Architecture View Adapter hard cutover、live UI coverage 已覆盖默认模型主路径。 |
| Full operation parity | 部分完成 | #31 read surface 已完成；`model.health`、`node.set-subtree/move/descope`、`responsibility.move`、`drift.flag`、`container.fill` 仍需 #32-#35 落实。 |
| 验证基线 | 当前 release gate 通过 | `corepack pnpm run tc` 通过；engine/IPC/renderer focused tests 通过；Architecture Electron e2e 三件套 22/22 通过，覆盖 active model reload、view-only no-write fingerprint、MCP alias matrix、visible `group.delete` 和 focused `person.add` API wiring。 |
| 剩余工作 | #32-#35 | 当前 Architecture slice 和 #31 read surface 已闭环；接下来按 structural、health/drift、container generation 和 adapter coverage 补 full operation parity。 |
| 明确不迁移 | 保持边界 | Scryer MCP server 产品路径、Tauri shell、独立 provider/settings UI、docs/templates marketplace、Rust sidecar runtime、正常 runtime 隐式 pre-0.3 自动迁移。 |

## Scryer 功能链

### 必须继承

- Scryer 0.3 模型数据：
  - `version: "0.3"`
  - `nodes`
  - `links`
  - `groups`
  - `sourceMap`，键为 responsibility id 或 schema node id
  - `boundaries`，键为 node id
  - committed/planned 双层模型
- 视觉编辑：
  - `C4Canvas`
  - `C4Node`
  - `RelationshipEdge`
  - `CodeLevelRack`
  - `ContextPanel`
  - `FlowScriptView`（历史 Orca 扩展；#28 hard cutover 已将其移出正常 Scryer 0.3 Architecture 产品路径）
  - `GroupsView`
  - `SyncBar`
- 模型存储：
  - 项目内 `.scryer/model.scry`
  - `.scryer/planned.scry`
  - `.scryer/model.baseline.scry`
  - `.scryer/.sync`
  - `.scryer/.lock`
  - `.scryer/history.jsonl`
  - `.scryer/.anchors.json`
  - `.scryer/.build_edges.json`
  - 文件监听和自动保存
- Scryer operation 语义，迁移到 Orca CLI：
  - `read_model`
  - `search_model`
  - `query_model`
  - `get_pending`
  - `get_drift`
  - `get_health`
  - `update_nodes`
  - `mark_implemented`
  - `move_nodes`
  - `set_model`
  - `set_node`
  - `delete_nodes`
  - `add_links`
  - `update_links`
  - `delete_links`
  - `set_groups`
  - `update_group`
  - `delete_group`
  - `update_source_map`
  - `validate_model`
  - `get_rules`
  - `read_codebase`
  - `add_person`
  - `add_system`
  - `add_container`
  - `add_component`
  - `add_group`
  - `add_symbol`
  - `flag_drift`
  - `reconcile_drift`
  - `fill_container`
- 任务排序逻辑：
  - `get_pending` 基于 committed/planned diff 生成 planned 差异项
  - `mark_implemented` 折叠 plan 到 committed
  - vagrant/stale flags 表示 drift verdict 前状态
  - responsibilities/properties/directives 表达模型责任
- drift sync：
  - boundaries 决定 drift scope
  - sourceMap anchors 和 `.anchors.json` 记录锚点指纹
  - `.sync` 记录 reconcile anchor
  - drift read 只报告需要复查的 scope，semantic verdict 由 `flag_drift` 写入 plan

### 需要改写

- Scryer 的 Tauri `invoke(...)` 要改成 Orca 的 preload API 和 Electron IPC。
- Rust 的 `scryer-core` 文件读写、drift、scan、rules 逻辑要改写成 TypeScript/Node 模块；ADR 0007 已决定不走 packaged Rust sidecar 产品路径。
- `scryer-mcp` 的工具语义要迁移成 Orca-native CLI `orca scryer <noun> <verb>` 和同源 Native TS operation layer，不保留 MCP server 作为产品路径。
- `scryer-acp` 里的 agent spawn 要接 Orca 现有的 agent/terminal 启动流程，而不是自己调用 `claude -p` 或 `codex exec`。
- Scryer 的 UI 主题和基础按钮组件要适配 Orca 现有 design system。

### 第一阶段舍弃

- Tauri app shell：`src-tauri/`
- Scryer 独立设置页：`SettingsPanel`
- Scryer 独立 AI Advisor provider 设置：`scryer-suggest`
- Scryer 独立安装 MCP 配置流程：`setup_mcp_integration`
- Scryer docs app、templates 的完整模板系统

这些不是永远不要，而是不应进入第一轮迁移。先把“架构图 tab 能打开、能编辑、能保存、agent 能读写”跑通。

## Orca 接入点

GitNexus 和源码确认的关键位置：

- `src/renderer/src/components/tab-bar/TabBar.tsx`
  - 截图中的 `New Terminal / New Browser Tab / New Markdown` 菜单在这里。
- `src/renderer/src/components/tab-group/useTabGroupWorkspaceModel.ts`
  - tab 的创建、激活、关闭、分组动作在这里汇总。
- `src/renderer/src/components/tab-group/TabGroupPanel.tsx`
  - active tab 的内容渲染在这里分发。
- `src/shared/types.ts`
  - `TabContentType` 和 `WorkspaceVisibleTabType` 需要新增架构图类型。
- `src/shared/workspace-session-schema.ts`
  - 会话恢复 schema 需要认识新 tab。
- `src/renderer/src/lib/workspace-session.ts`
  - 需要持久化架构图 tab。
- `src/renderer/src/store/slices/tabs.ts`
  - active surface 推导、close、reconcile 需要支持新类型。

## 目标功能边界

第一轮目标：

- Orca 的 `+` 菜单新增 `New Architecture`。
- 点击后打开一个架构图 tab。
- 架构图 tab 绑定当前 worktree。
- 默认使用当前项目下 `.scryer/model.scry`。
- 如果文件不存在，引导创建 0.3 空模型。
- 如果文件存在但不是 `version: "0.3"`，显示 upstream 一致的 model incompatibility 错误，不自动迁移。
- 可以编辑 Scryer 0.3 节点和 links。
- 可以保存到 `.scryer/model.scry`。
- 可以通过 Orca-native `orca scryer ...` CLI 让 agent 读取和修改模型。
- 修改模型后 Orca tab 内实时刷新。
- source map 可以映射到 Orca 当前项目文件。
- drift sync 能提示“代码和架构图不一致”。

暂不做：

- 独立模板市场
- 多 provider AI advisor
- 外部 Scryer 桌面 app 联动
- 正常打开时自动迁移 pre-0.3 `.scry` 模型
- 和 Scryer 上游完全保持 UI 一致

## 逐项迁移清单

### 0. 准备和风险确认

- [x] 创建 workspace：`/home/ljian/wspace/orca-scryer`
- [x] 克隆 Orca 和 Scryer
- [x] 用 GitNexus 索引两个仓库
- [x] 定位 Orca new tab 菜单和 tab 模型
- [x] 定位 Scryer 模型、画布、MCP、drift、agent sync 逻辑
- [x] 明确源码/许可证处理方式：迁移功能语义并重新实现 Orca-owned 代码，不直接复制 upstream Scryer 实现源码进产品运行时
- [x] 决定后端路线：TypeScript/Node 原生实现，不走 Rust sidecar

已接受路线：TypeScript/Node 原生实现。原因是 Orca 已经是 Electron/Node 应用，走同一套 IPC、测试和打包更稳，并且当前迁移代码可继续演进为 Scryer 0.3 engine。

### 1. 新增 Orca 原生架构图 tab 壳

- [x] `src/shared/types.ts`
  - `TabContentType` 增加 `architecture`
  - `WorkspaceVisibleTabType` 增加 `architecture`
  - 新增 `ArchitectureWorkspace` 类型
- [x] `src/shared/workspace-session-schema.ts`
  - schema 接受 `architecture`
  - 持久化架构图 tab 的轻量状态
- [x] `src/renderer/src/store/slices/architecture.ts`
  - 新增 architecture slice
  - 管理 `architectureTabsByWorktree`
  - 管理 `activeArchitectureTabIdByWorktree`
  - 提供 `createArchitectureTab`
  - 提供 `closeArchitectureTab`
  - 提供 `setActiveArchitectureTab`
- [x] `src/renderer/src/store/types.ts`
  - 把 `ArchitectureSlice` 合并进 `AppState`
- [x] `src/renderer/src/store/index.ts`
  - 注册 `createArchitectureSlice`
- [x] `src/renderer/src/components/tab-bar/TabBar.tsx`
  - 增加架构图 tab 渲染类型
  - `+` 菜单增加 `New Architecture`
  - 使用图形相关 lucide icon，例如 `Network`
- [x] `src/renderer/src/components/tab-group/useTabGroupWorkspaceModel.ts`
  - 映射 architecture tab 到统一 tab 列表
  - 增加 `newArchitectureTab`
  - 增加 `activateArchitecture`
  - 增加 `closeArchitecture`
- [x] `src/renderer/src/components/tab-group/TabGroupPanel.tsx`
  - active tab 为 `architecture` 时渲染 `ArchitecturePanel`
- [x] 测试
  - `TabBar` 菜单有新项
  - 创建后 tab 出现在当前 group
  - 关闭、切换、分屏不破坏 terminal/browser/editor

当前实现说明：Phase 1 已接入 Orca 原生 tab 生命周期。`ArchitecturePanel` 已从占位替换为可交互架构画布，后续如需要和 Scryer ReactFlow 视觉完全一致，再单独迁移 `@xyflow/react` 版 C4Canvas。

- `corepack pnpm run tc:web`
- `corepack pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/tab-bar/group-tab-order.test.ts src/renderer/src/components/terminal/tab-type-cycle.test.ts src/renderer/src/lib/workspace-session.test.ts src/renderer/src/store/slices/tabs.test.ts`
- `corepack pnpm exec oxlint ...` 针对本次改动文件
- `corepack pnpm exec oxfmt --check ...` 针对本次改动文件

注意：`corepack pnpm run tc` 目前会在 `tc:cli` 阶段报一批既有 tsconfig include 错误，和本次 renderer tab 改动无关；`tc:web` 已通过。

### 2. 迁移 Scryer 模型类型和纯逻辑

- [x] 从 `scryer/src/types.ts` 迁移到：
  - `src/shared/scryer/model-types.ts`
- [x] 从 `scryer/crates/scryer-core/src/rules.rs` 迁移到：
  - `src/shared/scryer/rules.ts`
- [x] 从 `scryer/crates/scryer-core/src/lib.rs` 迁移模型文件逻辑到：
  - `src/main/scryer/model-store.ts`
- [x] 实现：
  - `getProjectScryerDir(projectPath)`
  - `getProjectModelPath(projectPath)`
  - `readModel(projectPath)`
  - `writeModel(projectPath, model)`
  - `readBaseline(projectPath)`
  - `writeBaseline(projectPath, model)`
  - `setImplementing(projectPath, active)`
  - `isImplementing(projectPath)`
  - `markSynced(projectPath)`
- [x] 从 `scryer/src/hooks/useModelStorage.ts` 迁移 parse/migration 逻辑到：
  - `src/shared/scryer/parse-model.ts`
- [x] 测试
  - 能读取空模型
  - 能创建 `.scryer/model.scry`
  - atomic write 不产生半截 JSON

可复用能力：`.scryer/model.scry`、`.scryer/model.baseline.scry`、`.scryer/.sync`、`.scryer/.implementing` 的项目内读写；空模型创建；无效 JSON 报错；原子写入。
当前 Native Scryer Engine 已把正常 runtime 固定到 upstream 0.3 `ScryModel`
语义：`model.scry` 缺少 `version: "0.3"` 或版本不匹配时返回结构化
`incompatible_model`；`planned.scry` 缺失时从 committed 回退；新建空模型写
0.3 `ScryModel`；正常 read/open 不做 pre-0.3 字段迁移。若以后需要保留旧
Orca/Scryer 数据，应另做显式 import 命令。

### 3. 建立 Electron IPC 和 preload API

- [x] `src/preload/api-types.ts`
  - 增加 `architecture` API 类型
- [x] `src/preload/index.ts`
  - 暴露 `window.api.architecture.*`
- [x] `src/main/ipc/register-core-handlers.ts`
  - 注册架构图 IPC handler
- [x] API 初始集合：
  - `architecture.readModel(projectPath)`
  - `architecture.writeModel(projectPath, data)`
  - `architecture.watchModel(projectPath)`
  - `architecture.checkDrift(projectPath)`
  - `architecture.markSynced(projectPath)`
  - `architecture.callTool(projectPath, call)`
- [x] 测试
  - preload 类型通过
  - renderer 不能直接访问 Node fs
  - IPC 错误能显示给用户

当前状态：`src/main/ipc/architecture.ts` 注册 read/write/watch/drift/sync/native operation layer，文件变化通过 `architecture:modelChanged` 推到 renderer。

### 4. 迁移基础架构图 UI

- [x] 新建目录：
  - `src/renderer/src/components/architecture/`
- [x] 迁移并改写第一版可用画布：
  - `scryer/src/App.tsx` -> `ArchitecturePanel.tsx`，只保留 tab 内需要的部分
- [x] 已继续迁移 Scryer 人类交互视图：
  - `scryer/src/ContextPanel.tsx`
  - `scryer/src/FlowScriptView.tsx`
  - `scryer/src/GroupsView.tsx`
  - `scryer/src/SyncBar.tsx`
- [x] 已继续迁移 Scryer 代码层和 group overlay 视觉：
  - `scryer/src/CodeLevelRack.tsx`
  - Scryer group bubble 视觉的成员范围计算和 ReactFlow overlay
- [x] 已迁移并适配 Orca：
  - `scryer/src/C4Canvas.tsx` 的 ReactFlow 核心画布、面包屑、MiniMap、Controls、snap grid、auto layout 入口
  - `scryer/src/nodes/*` 的节点形状、person 节点、reference 节点、contract badge、hint badge、source link、component member chips
  - `scryer/src/edges/*` 的 relationship edge、状态颜色、双向边偏移、route waypoint、label/method 渲染
  - `scryer/src/edgeRouting.ts` 的 handle 分配逻辑
  - `scryer/src/edgeBundling.ts` 的 hub edge bundling 逻辑
  - `scryer/src/layout.ts` 的 code-level grid layout 和 d3-force auto layout
- [x] 删除/替换：
  - `@tauri-apps/api` 调用
  - Scryer 自带 settings panel
  - Scryer 独立 toast/provider
- [x] 接入 Orca：
  - [x] 使用 Orca 的 `sonner` toast
  - [x] 使用 Orca 的 `Button/DropdownMenu` 组件
  - [x] 使用 Orca 主题变量
  - [x] 禁止把 Scryer app 外壳嵌成“套娃页面”
- [x] 增加依赖：
  - [x] `@xyflow/react`
  - [x] `d3-force`
  - [x] `@types/d3-force`
  - [ ] `bubblesets-js`：当前未引入；Orca 先用 ReactFlow `ViewportPortal` 按成员节点位置渲染真实 group overlay，如后续要求有机 BubbleSets 曲线再单独引入
- [x] 测试
  - 架构图 tab 首屏不是空白
  - 可以新增节点
  - 可以拖动节点
  - 可以连线
  - 可以保存并重开

已修复的 live e2e 交互问题：

- ReactFlow selection 不能反向控制 Orca inspector 选中状态，否则会在 `null/id` 之间循环触发最大更新深度错误。
- 画布拖拽保存必须基于最新模型更新位置，避免覆盖刚保存的 source map。
- `Source pattern` blur 时必须读输入框当前值，不能依赖可能滞后的 React state。
- 模型 reload 不能无条件清空正在输入的 source pattern 草稿。

仍未追求像素级完全等价：Scryer package 里有 `bubblesets-js` 依赖，但当前源码没有直接调用点；Orca 现阶段实现的是真实成员范围 overlay，不是有机曲线 BubbleSets。若后续需要完全复刻 Scryer 的有机 bubble 形状，再单独引入该依赖。

### 5. 接 source map 和 Orca 文件打开

- [x] 改写 `SourceMapSection` 的核心编辑和打开文件逻辑
- [x] 把 Scryer `open_in_editor` 改成 Orca 内部打开文件
- [x] source map 点击后：
  - 优先在 Orca editor tab 打开文件
  - 有 line 时跳转行号
  - 文件不存在时给清楚提示
- [x] flow/source map 路径解析支持 `command` 字段保留
- [x] 测试
  - 点击 source map 打开当前 worktree 文件
  - line/endLine 正确传递
  - glob pattern 只在当前 worktree 内解析

当前状态：`src/shared/scryer/source-map-paths.ts` 会把 exact path 和 glob 都限制在当前 worktree 内，防止 `../` 跳出项目；Architecture 面板点击 source map 后会打开 Orca editor，并把行号传给 editor reveal 逻辑。live e2e 已验证 `src/index.ts` 能从架构节点跳到 Orca editor。

### 6. 迁移 Scryer operation 语义到 Orca CLI / Native TS engine

当前状态：operation catalog foundation 已落地，Architecture 产品主路径已经经
`executeOperation(...)` 与 `readView(...)` 跨过 Native Scryer Engine seam。
但 full 33-operation parity 尚未完成：catalog 里仍有 7 个 operation 没有
executor。transport adapter 只能对已 executable 的 operation 宣称已迁移。

| 能力族 | 当前 executable | 仍需落实 |
| --- | --- | --- |
| Read/query | `scryer.model.read`、`scryer.model.search`、`scryer.model.query`、`scryer.rules.read`、`scryer.codebase.read`、`scryer.model.validate` | 无单独剩余；#31 read surface gate 已覆盖 |
| Plan/model write | `scryer.plan.pending`、`scryer.plan.fold`、`scryer.model.set` | 无单独剩余；继续由 #30 audit 证明链路 |
| Structural writes | `scryer.node.update`、`scryer.node.delete`、`scryer.link.add/update/delete` | `scryer.node.set-subtree`、`scryer.node.move`、`scryer.responsibility.move`、`scryer.node.descope`：#32 |
| Source/group | `scryer.source.update`、`scryer.group.add/set/update/delete` | full parity coverage gate：#35 |
| Intent writers | `scryer.person.add`、`scryer.system.add`、`scryer.container.add`、`scryer.component.add`、`scryer.symbol.add` | full parity coverage gate：#35 |
| Drift/health | `scryer.drift.get`、`scryer.drift.reconcile` | `scryer.model.health`、`scryer.drift.flag`：#33 |
| Generation | 无 executable `container.fill` | `scryer.container.fill`：#34 |
| Adapters/live coverage | Architecture stable product path covered by #28/#29 | Remaining operation adapter and e2e/command gates：#35 |

已完成的 Native Engine 深模块和测试面：

- `src/main/scryer/engine/catalog.ts` 注册 broad operation catalog 和 contract policy。
- `src/main/scryer/engine/pipeline.ts` 统一 context、schema、lock/lease、declared reads/writes、result/error envelope。
- `src/main/scryer/engine/state-store.ts` 统一 `.scryer/*` durable IO、0.3 parse、planned fallback、atomic write 和 sidecar 维护。
- `src/main/scryer/engine/source-router.ts`、`id-minter.ts`、`diff.ts`、`fold.ts`、`validators.ts` 和 `operations/*` 承载当前 executable slice 的共享语义。
- `src/main/scryer/engine/operations/*` 应保持 thin executor 角色，不拥有 transport formatting 或私有文件 IO。
- IPC、legacy compatibility shim 和 Architecture e2e 已有 focused tests 证明稳定产品路径跨 engine seam。

当前验证基线：

- `corepack pnpm exec vitest run --config config/vitest.config.ts src/main/scryer/engine/*.test.ts src/main/scryer/engine/**/*.test.ts`
- `corepack pnpm exec vitest run --config config/vitest.config.ts src/main/scryer/model-store.test.ts src/main/scryer/mcp-tools.test.ts src/main/ipc/architecture.test.ts`
- `corepack pnpm run tc:node`
- `corepack pnpm run tc:cli`
- `corepack pnpm run tc:web`
- `SKIP_BUILD=1 corepack pnpm exec playwright test tests/e2e/architecture-tab.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1`
- `git diff --check`

产品集成固化已完成到 #29；#30 已完成 catalog reality 审计；#36 已关闭当前
Architecture slice strict release gate。当前 decision frontier 是 #32-#35：

- #26：主进程默认模型 read/patch/drift/reconcile 和 `mcp-tools.ts` Scryer 0.3 compatibility shim 已清除 cataloged-operation legacy fallback；renderer 的旧 `C4ModelData` 文档保存主路径已在 #28 hard cutover 中移除，而不是继续作为兼容层收敛。
- #27：已固化 `ScryerEditSessionController` + Completion Gate。agent `done` 之后会检查 planned pending foldability 和 validation，再决定是否允许 fold；lease token 只属于 main-process/controller/engine trusted context，renderer/preload DTO、DOM/log/prompt 和 renderer `executeScryerOperation(...)` 输入不暴露也不接收 `leaseToken`。
- #28：已固化 renderer-facing Architecture View Adapter，采用 hard cutover：React 只消费 `ArchitectureViewDto`，命名跟随上游 `nodes`/`links`/`groups`/`sourceMap`/`boundaries`，Architecture renderer 移出 `C4ModelData`/`C4Node`/`C4Edge` 正常路径，移除 `flows`/`scenarios` 功能，UI intent 统一转成 catalog operation input。
- #29：已扩大 live UI intent/behavior coverage，稳定 product path 的真实可见控件读写已跨 `readView(...)` / `executeOperation(...)`，view-only 状态不改 `.scryer/model.scry`；group nesting / bulk group restore 仍以 operation-backed setup 加文件效果断言覆盖，不作为 headless pointer-dnd gate。
- #30：已审计 executable Architecture slice 的真实前后端链路，并把 operation catalog reality 写入 `docs/orca-scryer-architecture-slice-audit.md`。
- #36：已补 #30 发现的当前 slice release gate 缺口：active model reload、非默认模型管理 out-of-scope 决策、view-only no-write fingerprint、MCP alias matrix、`group.delete` 可见路径、`person.add` focused API 覆盖。
- #31：已补 read/query/rules/codebase executable operations 和 read-surface gate。
- #32：补 set-subtree、node move、responsibility move、descope executable operations。
- #33：补 health report 和 drift semantic flag executable operations。
- #34：补 container fill atomic generation executable operation。
- #35：补剩余 operation 的 adapter/CLI/IPC/agent/live coverage gate。

明确 future/out-of-scope：

- 正常打开 `.scryer/model.scry` 时不做隐式 pre-0.3 自动迁移；如需保留旧数据，应另做显式 import 命令。
- 正常 Scryer 0.3 runtime 采用 closed schema：`.scryer/model.scry` / `.scryer/planned.scry` 发现任意未知字段时拒绝加载或保存，并通过结构化 `incompatible_model` error envelope 返回所有 unknown field path；#28 不做旧模型兼容、import、migration、fallback 或 `edges -> links` 转换。
- Scryer MCP server、Tauri shell、独立 provider/settings UI、docs/templates marketplace、Rust sidecar runtime 不属于 Orca product path。
- group bubble 的 `bubblesets-js` 有机曲线、像素级视觉复刻和未来 AI fill 体验不是当前 Architecture product slice 的完成条件。

### 7. 迁移 drift detection 和 sync

- [x] 从 `scryer-core/src/drift.rs` 改写：
  - `checkSourceDrift`
  - `checkStructureDrift`
  - 忽略目录规则
- [x] 从 `scryer-acp/src/prompt.rs` 改写：
  - `initialModelPrompt`
  - `nodeFillPrompt`
  - `syncPrompt`
  - `serializeModelForPrompt`
- [x] 不直接照搬 `scryer-acp/runtime.rs`
  - 改用 Orca 现有 agent terminal 启动流程
  - sync 时可创建一个 agent terminal tab，并注入 prompt
  - agent 通过 Orca-native `orca scryer ...` CLI / native operation layer 更新 `.scryer/model.scry`
- [x] UI：
  - 第一版 drift report 和 mark synced 已接入 `ArchitecturePanel`
- [x] 后续 UI：
  - 改写 SyncBar 的核心流程到底部 Orca 原生状态条
  - sync 中锁住架构图编辑
  - 支持 cancel，cancel 恢复 pre-sync snapshot
  - 支持 finish，finish 更新 baseline 并解除 implementing lock
  - 支持 Orca agent 状态 `done` 后自动 finish
  - 支持手动 check drift，drift 明细节点可跳回架构图
- [x] 测试
  - source-mapped 文件变化会提示 drift
  - mark synced 后提示消失
  - [x] sync 失败显示错误
  - [x] cancel 恢复模型
  - [x] SyncBar check/finish/cancel/lock 走 Orca IPC 和 native Scryer operation layer
  - [x] Orca agent tab 报告 `done` 后自动 finish，清理 `.implementing` 并写 baseline

当前状态：`src/main/scryer/drift.ts` 会扫描当前 worktree，忽略 `.git/.scryer/node_modules/build/out` 等目录；按 source map glob 找到变更节点；按文件创建时间检测结构变化；`src/main/scryer/sync.ts` 会在 sync 前写 pre-sync 快照、设置 `.implementing`、生成给 Orca agent 的 sync prompt；cancel 会恢复快照，finish 会更新 baseline 并清掉临时状态。前端 controller 会监听新开的 Orca agent tab 的 `agentStatusByPaneKey`，当该 tab 报告非中断 `done` 时自动调用 `finishSync`。live e2e 已模拟“用户编辑架构图 -> mark synced -> 修改源码 -> drift report 命中 source-mapped node”，并覆盖 source map 打开 Orca editor、sync/cancel 恢复、agent done 自动 finish、重启恢复架构 tab。

### 8. Orca UI 打磨和快捷键

- [x] `New Architecture` 菜单文字和 icon
- [x] tab 标题：
  - 默认 `Architecture`
  - 有模型名时显示模型名
- [x] 空状态：
  - 当前项目没有 `.scryer/model.scry` 时提供创建按钮
  - 当前 worktree 不存在时禁用创建
- [x] 快捷键暂不占用，避免和现有 `Ctrl+T / Ctrl+Shift+B / Ctrl+Shift+M` 冲突
- [x] 分屏：
  - 架构图 tab 可拖到 split group
  - 同一个 worktree 可以打开多个架构图 tab，但共享同一个模型文件

### 9. 验证

- [x] 新增 package 依赖，并已更新 `pnpm-lock.yaml`
- [x] `pnpm run tc:web`
- [x] `pnpm run tc:node`
- [x] 改动文件 `oxlint`
- [x] 改动文件 `oxfmt --check`
- [x] focused unit suite：14 个文件、121 个测试
- [x] 新增/更新 e2e：
  - [x] `New Architecture` 菜单可见
  - [x] 新建架构图 tab
  - [x] 画布节点新增、改名、拖动
  - [x] `.scryer/model.scry` 写入
  - [x] native operation layer 写入后 UI 自动刷新
  - [x] source-mapped 代码改动触发 drift report
  - [x] FlowScriptView 新建步骤、mention 插入、条件分支、flow source map 打开 editor（历史覆盖；#28 已移除正常产品路径）
  - [x] GroupsView 新建 group、拖入成员、group 嵌套、成员移除并持久化
  - [x] SyncBar 手动 drift check、dismiss、sync/cancel/finish 状态链
  - [x] SyncBar 接 Orca agent 状态，agent `done` 后自动 finish
  - [x] 切换 terminal/browser/editor/architecture 不丢状态
  - [x] 重启后恢复 architecture tab
- [x] live e2e：
  - [x] 画布编辑、`.scryer/model.scry` 写入、工具层写入刷新、drift 检测
  - [x] source map 打开 Orca editor、sync/cancel 恢复
  - [x] flow 和 group 视图的真实人类交互
  - [x] Orca agent 状态 `done` 后自动 finish
  - [x] clean relaunch 后恢复 architecture tab 和模型状态
- [x] 手动/自动检查：
  - 首屏不空白
  - 画布能交互
  - 保存文件可读
  - agent 能通过 Orca-native `orca scryer ...` CLI 读写模型

## 建议执行顺序

历史执行顺序已经完成到 Architecture product slice 闭环：Orca 原生
Architecture tab、本地 `.scryer` 文件读写、Native Scryer Engine seam、
IPC adapter、drift/sync 和 agent done 联动都有实现与 focused tests。

decision map #28-#29 已完成：Architecture View Adapter hard cutover 和 live UI
intent/behavior tests 都已落地。#30 审计和 #36 release gate hardening 已把当前
Architecture slice 闭环。#31 read surface 已闭环。当前继续顺序是用 #32-#35
补 7 个 catalog-only operation 的 executor、adapter 和覆盖。PR 发布/验收仍应避免把 full parity 未完成项误写成当前 PR 已完成。
