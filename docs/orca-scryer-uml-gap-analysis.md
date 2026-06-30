# orca-scryer UML 差异分析

生成时间：2026-05-11

Document boundary: this is a linked UML/gap-analysis asset. It compares product
flows and implementation gaps; it is not the decision map, not an ADR, and not a
glossary. The compact planning authority is
[orca-scryer-decision-map.md](./orca-scryer-decision-map.md).

本文用 UML 风格对比 Scryer 原始实现和当前 Orca 迁移实现，重点不是看某个按钮是否存在，而是看“人类操作前端 -> 前端状态变化 -> 后端持久化 -> agent/Scryer operation 外部改写 -> 前端重新理解状态”的完整链路。

## 结论

当前 Orca 迁移已有真实 Architecture 产品链路：ReactFlow 画布、节点/边编辑、group 编辑、source map、drift、Native Scryer Engine operation layer、sync/cancel/finish 都走了真实 `.scryer/model.scry` / `.scryer/planned.scry` 和 Electron IPC。#26-#29 产品集成固化已完成到 Architecture View Adapter hard cutover 和 live UI coverage。旧 flow 功能是 Orca 历史扩展，不属于 upstream Scryer 0.3 Architecture 模型，已在 #28 hard cutover 中从正常产品路径移除。

不要把这解读成 full Scryer operation parity 已完成。当前 catalog 注册 33 个 operation id，其中稳定 Architecture product slice 已有 executor；`model.search/query`、`rules.read`、`codebase.read`、`model.health`、`node.set-subtree/move/descope`、`responsibility.move`、`drift.flag`、`container.fill` 仍是 catalog-only/stub，需要 decision map #31-#35 落实。

当前关键结构是 `useArchitectureModelController`：它把模型读取、写入、文件监听、外部变更 diff、高亮、follow 外部变更、撤销/重做、drift、sync/cancel/finish 和 Orca agent 完成状态监听集中到一个前端控制层，并接入 Orca 原生 tab/store/IPC/agent terminal。

仍需注意：当前目标是功能链和人类交互链对齐，不是逐像素复刻。比如 group bubble 已按成员位置真实计算并渲染 overlay，但没有引入 `bubblesets-js` 做有机曲线；AI provider 仍按要求走 Orca agent，不迁移 Scryer 独立 provider。

## 1. Scryer 原始前后端链路

```mermaid
flowchart LR
  User[User interaction] --> App[Scryer App.tsx]
  App --> Canvas[C4Canvas]
  App --> Context[ContextPanel]
  App --> Flows[FlowScriptView]
  App --> Groups[GroupsView]
  App --> Sync[SyncBar]

  Canvas --> State[React model state]
  Context --> State
  Flows --> State
  Groups --> State

  State --> History[useHistory]
  State --> Storage[useModelStorage]
  Storage --> Debounce[500ms debounced autosave]
  Debounce --> InvokeWrite[Tauri invoke write_model]
  InvokeWrite --> Rust[Scryer Rust commands]
  Rust --> ModelFile[.scryer/model.scry]

  Rust --> Watch[watch_project]
  Watch --> Events[model-created / model-changed]
  Events --> Storage
  Storage --> Diff[changedNodeIds + nodeDiffs]
  Diff --> Canvas
  Diff --> Context
  Storage --> FollowAI[followAI auto navigation]

  Sync --> StartAgent[start_agent_session]
  StartAgent --> Agent[ACP / agent runtime]
  Agent --> AgentEvents[agent-event stream]
  AgentEvents --> Sync
  AgentEvents --> Storage
  Agent --> MCP[scryer MCP]
  MCP --> ModelFile
```

Scryer 的关键点：

- UI 组件只负责交互，模型读写集中进 `useModelStorage`。
- `useModelStorage` 用 `lastKnownDisk` 避免自己写文件后又重复 reload。
- 外部 Scryer operation/agent 改写文件后，watcher 触发 reload，再计算 changed nodes、before/after diff、父层级变化和 follow AI 导航。
- `useHistory` 捕获同一份模型状态，所以 nodes、links、sourceMap、boundaries、groups 可以一起 undo/redo。
- sync 不是只显示状态条，后端 agent runtime 会发 `agent-event`，前端根据 completed/cancelled/failed 自动 mark synced、reload model、展示 diff。

## 2. 当前 Orca 迁移链路

```mermaid
flowchart LR
  User[User interaction] --> Panel[ArchitecturePanel]
  Panel --> Canvas[ArchitectureCanvas]
  Panel --> Context[ArchitectureContextPanel]
  Panel --> Groups[GroupsView]
  Panel --> Sync[SyncBar]

  Canvas --> Persist[persist / applyModelChange]
  Context --> Persist
  Groups --> Persist

  Persist --> Preload[window.api.architecture]
  Preload --> IPC[Electron IPC architecture:*]
  IPC --> Store[main/scryer/model-store.ts<br/>legacy compatibility / file plumbing]
  Store --> ModelFile[.scryer/model.scry]

  IPC --> Drift[main/scryer/drift.ts]
  IPC --> Ops[Native Scryer Engine<br/>executeOperation / readView]
  IPC --> SyncMain[main/scryer/sync.ts]
  Ops --> EngineStore[engine/state-store.ts]
  EngineStore --> ModelFile
  SyncMain --> Snapshot[model.presync.scry + .implementing]

  IPC --> Watch[fs.watch .scryer]
  Watch --> ModelChanged[architecture:modelChanged]
  ModelChanged --> LoadModel[ArchitecturePanel.loadModel]
  LoadModel --> Panel

  Sync --> BeginSync[beginSync]
  BeginSync --> Prompt[generated sync prompt]
  Prompt --> OrcaAgent[Orca agent terminal tab]
  OrcaAgent --> Ops
  Sync --> Finish[finishSync]
  Sync --> Cancel[cancelSync restores snapshot]
```

Orca 当前做对的地方：

- 没有迁移 Scryer Tauri 外壳，而是接入 Orca 原生 tab、preload、Electron IPC、store、agent terminal。
- Native Scryer Operation Catalog、typed operation contracts、pipeline、state-store、schemas 和 ownership tests 已建立；Architecture 产品主路径的 executable operations 已跨过 engine seam。
- `beginSync` 写 pre-sync snapshot 和 `.implementing`，所以切换 tab、重启后还能恢复 sync 中状态。
- source map 直接打开 Orca editor，不再走 Scryer 的独立 `open_in_editor`。
- `useArchitectureModelController` 已集中管理模型状态、外部变更 diff/follow、undo/redo 和 sync 生命周期。
- sync 已接 Orca agent 状态：新开的 agent tab 报告非中断 `done` 时自动 `finishSync`，更新 baseline 并清除 `.implementing`。

目标 deep module 链路：

```mermaid
flowchart LR
  UI[Architecture UI] --> ViewAdapter[Architecture View Adapter]
  CLI[orca scryer CLI] --> CLIAdapter[CLI Adapter]
  IPC[Electron IPC] --> IPCAdapter[IPC Adapter]
  Agent[Codex / Claude Code] --> CLIAdapter

  ViewAdapter --> Engine[ScryerEngine<br/>executeOperation / readView]
  CLIAdapter --> Engine
  IPCAdapter --> Engine

  Engine --> Pipeline[Operation Pipeline]
  Pipeline --> Catalog[Operation Catalog]
  Pipeline --> StateStore[Scryer State Store]
  Pipeline --> Validator[Scryer Validator]
  Pipeline --> EditSession[ScryerEditSessionController]

  StateStore --> Files[.scryer model / planned / history / anchors]
  AgentBridge --> OrcaRuntime[Orca runtime / terminal state]
  ViewAdapter --> ViewState[selection / layout / render cache / flow extension]
```

这个目标链路的关键不是多加文件，而是把 seam 放对：UI、CLI、IPC、agent 都是 adapter；`ScryerEngine` 是语义 Module；pipeline、state store、validator、`ScryerEditSessionController` 是它的深模块或专用 workflow seam。删除 adapter 不应该删除 Scryer 语义；删除 engine 才会让复杂性重新散落到多个调用者。

主要剩余差距：

- Full operation parity：当前还需要 #31-#35 补齐 catalog-only operations 的 executor、adapter 和 coverage；这不同于 #28/#29 Architecture 产品链路。
- PR 准备：#28/#29/#30/#36 release-gate diff 已在 clean worktree 中和相邻历史改动分离，并已完成 final review/test gate；后续是推送 PR 和人工验收。
- #26-#29 已完成，#36 release gate 已关闭：legacy semantic owners 已降级为 engine-backed shim 或清理出 cataloged-operation 语义路径；`ScryerEditSessionController` + Completion Gate 已固化；Architecture renderer 已消费 `ArchitectureViewDto`；live UI coverage 已扩大到稳定 product path 的真实可见控件和 `.scryer` 文件效果，包含 active model reload、view-only no-write、MCP alias matrix、visible `group.delete` 和 focused `person.add` API 覆盖。
- group bubble 目前是按节点范围计算的 ReactFlow overlay，未做 `bubblesets-js` 的有机曲线形状。
- Scryer 的独立 AI advisor/provider 按用户要求不迁移；如果以后要“AI 填充节点”，应该接 Orca agent 能力，而不是新增 provider 设置。

## 3. 编辑保存时序对比

```mermaid
sequenceDiagram
  actor User
  participant SUI as Scryer UI
  participant SMS as useModelStorage
  participant Tauri as Tauri command
  participant SFile as .scryer/model.scry
  participant OUI as Orca ArchitecturePanel
  participant IPC as Electron IPC
  participant OStore as model-store.ts
  participant OFile as .scryer/model.scry

  User->>SUI: edit node / edge / flow / group
  SUI->>SMS: set React model state
  SMS->>SMS: capture history + debounce save
  SMS->>Tauri: write_model
  Tauri->>SFile: atomic write

  User->>OUI: edit node / link / group
  OUI->>OUI: update view/session state
  OUI->>IPC: execute operation intent
  IPC->>Engine: executeOperation / readView
  Engine->>OFile: atomic planned/committed write
```

Orca 已补齐的逻辑：

- `persist/applyModelChange/loadModel/watchModel` 已收敛为 renderer view/session controller 逻辑。
- #28 已把节点、links、groups、source map、boundaries 等语义写入改为通过 view adapter / engine seam 的 intent operation；旧 `flows`/`scenarios` 已从正常产品路径移除。
- controller 维护 view/session state、external changes、sync terminal tab 和 agent done 自动 finish；语义状态以 `ArchitectureViewDto` 和 `.scryer` planned/committed state 为准。

## 4. 外部 Scryer operation/agent 写入刷新对比

```mermaid
sequenceDiagram
  participant STool as Scryer upstream tool / agent
  participant SFile as Scryer model file
  participant SWatch as Scryer watcher
  participant SMS as useModelStorage
  participant SCanvas as C4Canvas + ContextPanel
  participant OFile as Orca model file
  participant OWatch as architecture:modelChanged
  participant OPanel as ArchitecturePanel
  participant OTool as Orca CLI/native operation

  STool->>SFile: write updated model
  SWatch->>SMS: model-changed
  SMS->>SMS: compare raw with lastKnownDisk
  SMS->>SMS: compute changedNodeIds + nodeDiffs
  SMS->>SMS: preserve selected/measured/positions where possible
  SMS->>SMS: followAI navigate to changed level
  SMS->>SCanvas: flash changed nodes + show before/after diff

  OTool->>OFile: write updated model through native operation layer
  OWatch->>OPanel: architecture:modelChanged
  OPanel->>OPanel: loadModel replaces model
  OPanel->>OPanel: keep selected edge if still present
```

这里已从“文件级 reload”推进到“模型级理解”：Orca 会比较前后模型，生成 changed node、高亮、before/after diff，并在 follow external changes 打开时跳到变化节点所在层级。live e2e 已覆盖工具层写节点后 UI 自动显示 changed glow 和 before/after diff。

## 5. Sync/drift 时序对比

```mermaid
sequenceDiagram
  actor User
  participant SSync as Scryer SyncBar
  participant SBack as Tauri/Rust backend
  participant SAgent as Scryer agent runtime
  participant SMS as useModelStorage
  participant OSync as Orca SyncBar
  participant OMain as main/scryer/sync.ts
  participant OAgent as Orca agent terminal
  participant OTools as Orca CLI/native Scryer operations

  User->>SSync: Sync
  SSync->>SBack: start_agent_session
  SBack->>SAgent: spawn configured agent
  SAgent-->>SSync: agent-event message/completed/failed
  SAgent->>SMS: model reload after completion
  SSync->>SBack: mark_synced + sync_diff

  User->>OSync: Sync
  OSync->>OMain: beginSync
  OMain->>OMain: write presync snapshot + .implementing
  OMain-->>OSync: prompt + drift
  OSync->>OAgent: launch Orca terminal with prompt
  OAgent->>OTools: read/write model through native operation layer
  User->>OSync: Finish or Cancel
  OSync->>OMain: finishSync or cancelSync
```

Orca 的差异来自 agent 体系归属：agent 生命周期归 Orca terminal 管，不归 Scryer runtime 管。关键闭环是架构 tab 记录自己启动的 agent terminal tab，并监听 Orca `agentStatusByPaneKey`；该 tab 报告非中断 `done` 时自动 `finishSync`。用户仍可在异常或中断场景下手动 finish/cancel。

## 6. 模型状态机

```mermaid
stateDiagram-v2
  [*] --> Loaded
  Loaded --> Dirty: user edits model
  Dirty --> Saving: persist/writeModel
  Saving --> Loaded: write ok
  Loaded --> Drifted: checkDrift finds source/structure drift
  Drifted --> Synced: markSynced
  Loaded --> SyncRunning: beginSync
  Drifted --> SyncRunning: beginSync
  SyncRunning --> ExternalChanged: agent/tool writes model
  ExternalChanged --> SyncRunning: watcher reload
  SyncRunning --> Synced: finishSync
  SyncRunning --> Loaded: cancelSync restores presync snapshot
  SyncRunning --> SyncError: begin/finish/cancel failed
  SyncError --> Loaded: dismiss error
```

Scryer 已经把 `ExternalChanged` 的前端表现做得更细：高亮、diff、自动跳转、保留布局。Orca 现在已有文件 reload、changed glow、before/after diff 和 follow external changes 的核心链路；像素级动效和独立 AI fill 体验不属于 #28/#29 完成条件。

## 7. 差异清单

| 模块           | Scryer 原始逻辑                                                        | Orca 当前状态                                                 | 结论                                               |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| 模型保存       | `useModelStorage` 集中保存，500ms debounce，跳过 sync 中保存           | `useArchitectureModelController` 集中读写 IPC                 | 已对齐核心链路                                     |
| 文件监听       | `watch_project` + `model-created/model-changed` + `lastKnownDisk` 去重 | `fs.watch .scryer` + fingerprint 去重 + controller reload     | 已对齐 Orca IPC 链路                               |
| 外部变更理解   | `changedNodeIds`、`nodeDiffs`、followAI、位置保留                      | changed glow、before/after diff、follow external changes      | 已迁移核心语义                                     |
| undo/redo      | `useHistory` 捕获完整模型状态                                          | 旧整份 `C4ModelData` 捕获已不属于正常产品路径                   | 若重新引入，需作为 intent/operation 或 renderer view/session 级策略 |
| ContextPanel   | 支持 node/edge/group、diff 展示、contract/source map/relationships     | node/edge/group 编辑、diff 展示、contract/source map/关系编辑 | 已迁移主要交互                                     |
| FlowScriptView | upstream 0.3 无 Architecture flow 模型                                 | Orca 历史扩展                                                  | #28 正常产品路径移除                              |
| GroupsView     | dnd、成员、嵌套、canvas groups 模式                                    | dnd、成员、嵌套、multi-select 建组、canvas group overlay      | 已迁移主要交互                                     |
| SyncBar        | agent-event 自动更新日志、完成后 mark synced/reload/sync_diff          | Orca terminal prompt + finish/cancel + agent done 自动 finish | 已接 Orca agent 状态                               |
| drift          | Rust 检测 source map 和结构变化                                        | TypeScript 检测 source map 和结构变化                         | 已有真实逻辑，继续扩大 e2e                         |
| Scryer Operation Surface | Scryer upstream tool runtime                                 | Orca-native Native Scryer Engine catalog；Architecture product slice executable | #26-#29 产品集成固化已完成；full operation parity 仍需 #31-#35 |
| AI advisor     | Scryer 独立 provider、hints、fill with AI                              | 按要求未迁移                                                  | 不迁移独立 provider；可接 Orca agent 能力          |
| Tauri shell    | Tauri desktop app                                                      | 按要求未迁移                                                  | 正确舍弃                                           |

## 8. 剩余风险

核心链路已有真实读写路径：画布、GroupsView、SyncBar、Native Scryer Engine operation layer、drift 和 sync snapshot。FlowScriptView 属于历史扩展，不再作为 #28/#29 完成目标。#30/#36 审计见 `docs/orca-scryer-architecture-slice-audit.md`：当前 Architecture 默认模型 release-critical 主链路已打通并通过严格 zero-partial release gate。剩余 operation parity gap 不阻塞当前 Architecture 默认模型主路径的前后端打通判断，但会阻塞“full Scryer parity complete”的声明。

剩余差异：

1. #31-#35：需要补齐 catalog-only operations 的 executor、adapter 和 coverage。
2. PR 准备：#28/#29/#30/#36 docs/code/test diff 已隔离为可 review 的 clean-branch 变更集，后续是推送 PR 和人工验收。
3. group bubble 是真实成员范围 overlay，但还不是 `bubblesets-js` 有机曲线。
4. AI provider 不迁移是明确边界；如果要 AI fill，需要走 Orca agent，而不是 Scryer provider。
5. 视觉密度和细节仍可能和 Scryer 有差异；主要默认模型交互、状态管理、持久化和 release-critical live e2e 已覆盖，但像素级视觉复刻仍不是当前 gate。

## 9. 第二阶段细粒度迁移清单完成情况

1. 新增 `useArchitectureModelController`
   - 输入：`projectPath`、当前 tab/worktree 信息。
   - 输出：`model`、selection、expandedPath、activeFlowId、dirty/saving/error、changedNodeIds、nodeDiffs、followAI、undo/redo、所有 mutation 方法。
   - 迁移现有 `loadModel/persist/applyModelChange/watchModel` 到 controller。
   - 状态：已完成。单元测试覆盖空模型、fingerprint 和 agent done 判定；live e2e 覆盖 controller 真实读写链。

2. 迁移 Scryer 外部变更 diff 链
   - 记录 `lastKnownDisk`。
   - watcher reload 时比较 before/after nodes 和 links。
   - 生成 `changedNodeIds` 和 `nodeDiffs`。
   - Canvas 节点闪烁，ContextPanel 展示 before/after 值。
   - 状态：已完成核心链。live e2e 已通过工具层改节点状态并显示 changed glow 和 diff。

3. 迁移 follow AI / follow agent 导航
   - 保留用户开关。
   - 外部变更落在 container/component 子层级时自动切换 expandedPath。
   - 多层级同时变化时按 Scryer 逻辑选择较浅层级。
   - 状态：已完成外部变更 follow 开关和层级跳转；后续若接独立 AI fill，再接 Orca agent。

4. 迁移模型 undo/redo
   - 迁移 `useHistory` 思路，但适配 Orca controller。
   - 快捷键需避开 Orca 全局快捷键冲突。
   - 目标覆盖 upstream 0.3 `nodes`、`links`、`sourceMap`、`boundaries`、`groups`；`flows`/`scenarios` 不属于 upstream Scryer 0.3 Architecture 模型并已在 #28 正常产品路径中移除。
   - 状态：#28 hard cutover 已将 renderer 语义写入收敛到 intent/operation；撤销/重做若重新引入，应作为 renderer view/session 层策略或显式 future 工作处理。

5. 补 ContextPanel diff 和 group context
   - 节点 diff before/after 展示。
   - group identity、contract、members 编辑链路对齐 Scryer。
   - 状态：已完成主要交互；live e2e 覆盖 selected group 编辑说明和 contract ask。

6. 补 SyncBar 与 Orca terminal 生命周期联动
   - 不迁移 Scryer 独立 agent runtime。
   - 研究 Orca terminal/agent 状态源，监听 agent 完成/取消/失败。
   - 完成时自动 `finishSync`、reload model、check drift。
   - 状态：已完成 agent `done` 自动 finish；失败/中断仍保留人工 review/cancel 路径。

7. 补 group bubble 和 CodeLevelRack 视觉逻辑
   - group bubble 要真实根据成员节点位置计算，而不是静态背景。
   - 状态：已完成真实成员范围 overlay 和 component 代码层级 rack；未做 `bubblesets-js` 有机曲线。

8. 扩展 live e2e
   - 人类操作：创建/编辑/撤销/重做节点、links、group；flow 若保留，作为 Orca extension 单独验证。
   - agent 操作：工具层/CLI 写入多层级节点，UI diff/highlight/followAI。
   - sync 操作：begin -> agent 写 model -> 自动/手动 finish -> baseline 更新 -> drift 清空。
   - 状态：#29 已扩大 live coverage，覆盖稳定 product path 的真实可见控件、links、source/group 编辑、standard envelope、drift、sync/cancel/finish 和重启恢复；group nesting / bulk group restore 继续用 operation-backed setup 加文件效果断言。#30 继续把这些覆盖整理成前端-后端链路审计矩阵。

## 10. Orca 适配原则

- Tauri `invoke` 不应该原样搬进 Orca；正确做法是 `preload API -> Electron IPC -> main TypeScript service`。
- Scryer 的 AI provider 不迁移，但 Scryer 的模型语义、Scryer operation 语义、drift/sync 语义要保留。
- React 事件里直接读 state 容易读到 stale value；像 source pattern、sync reload 这类路径要用 ref 或 controller 避免 stale state。
- sync 中要有硬状态文件：`.implementing` 和 `model.presync.scry`，否则切 tab 或重启后 UI 会误以为没有任务在跑。
- e2e 不能只点按钮，要读回 `.scryer/model.scry` 或通过 IPC/CLI 工具验证真实文件变化。
- deep module seam 优先级高于文件拆分：`ScryerEngine.executeOperation(...)` 和 `readView(...)` 是产品调用 seam，其他模块应隐藏在 engine、view adapter 或 `ScryerEditSessionController` 后面。
- transport adapter 不应承载 Scryer 语义：CLI/IPC/UI 只能归一化输入、调用 engine、渲染 envelope。
- Model Edit Lease 和 Completion Gate 是 `ScryerEditSessionController` / pipeline 责任，不是普通 UI 或 CLI 调用者需要手动编排的步骤。
