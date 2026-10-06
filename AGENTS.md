# 设计系统

所有 UI 开发（布局、颜色、排版、间距、组件选取、UX 交互行为）必须严格遵循 [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md)。大部分规范已配置 lint 检查：`pnpm run check:code-quality:changed` 会拦截对 `components/ui/` 原语的非规范样式覆盖、硬编码调色板颜色以及动态计算的 `className` 字符串；`pnpm lint` 会拦截 Tailwind 无法生成的类名。在尝试抑制这些校验之前，请务必阅读样式指南中的“强制执行（Enforcement）”章节。仅使用 `src/renderer/src/assets/main.css`（规范来源）中定义的 token 以及 `src/renderer/src/components/ui/` 中的 shadcn 原语。当已有规范涵盖相应角色时，不要随意自创颜色值、字号或阴影层级。当 STYLEGUIDE.md 未明确说明时，请遵循其最后一节中的决策优先级。

## Electron UI 验证

始终在后台通过 `ORCA_BACKGROUND_LAUNCH=1` 运行测试和 Agent 启动的应用。
严禁抢占显示器焦点或显示测试窗口：禁止调用 `show()`、`showInactive()`、`bringToFront()`、`app.focus()` 或进行 OS 级窗口激活。请通过隐藏渲染器的 CDP 截屏进行验证。将需要原生焦点和可见窗口的测试在用户桌面上保持暂停；改在隔离显示环境或 CI 中运行。
在运行应用前，必须重新构建已修改的启动策略代码；使用陈旧的构建包装器是不安全的。

对渲染后的 Orca UI 检查请使用 `$electron` 技能和 Playwright CDP。切勿使用 computer-use 进行 Orca UI 验证。

# 代码风格

## 重新实现前先复用

在编写任何规模的新逻辑之前（无论是函数、组件、IPC 通道、状态仓库还是整个子系统/业务流程），首先检查是否已有现有实现能够完成（或接近完成）该工作。优先扩展或泛化现有逻辑，而不是构建平行版本；仅在完全没有合适实现时才从头编写。保持检查工作与实现规模相匹配：微小代码快速检索即可，构建重要功能前需做全面调研。

## 仅保留简短且非显而易见的注释

- 严禁：冗长啰嗦、解释显而易见的内容、逐行复述代码流程（解释“为什么”而不是“怎么做”）。
- 保持简练：尽量控制在 1 行以内。

## Lint 规则：严禁禁用 Max Lines

严禁添加 `max-lines` 禁用注释（如 `eslint-disable max-lines`、`oxlint-disable max-lines` 或特定行的变体），且严禁在 `mobile/.oxlintrc.json` 中为单个文件调大 `max-lines` 阈值。

## 文件与模块命名规范

严禁使用如 `helpers`、`utils`、`common`、`misc` 或 `shared-stuff` 等空洞名称命名文件、文件夹或模块。这些名称不包含具体信息，极易变成垃圾场。必须根据其实际包含的内容命名——优先使用具体业务领域概念（例如 `tab-group-state.ts`、`terminal-orphan-cleanup.ts`）而非通用角色名词（`tabs-helpers.ts`、`terminal-utils.ts`）。如果你想使用 `helpers`，通常说明该文件职责过多需要拆分，或者代码中隐藏着更能描述其操作对象的具体名称。

## 类型声明：优先使用 `.ts` 而非 `.d.ts`

## 类型断言：优先使用已校验类型

除 `as const` 外，应避免使用类型断言。无法避免的类型转换必须附加针对该行的 `SAFETY:` 说明：

```ts
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 在此处解释已验证的不变量。
```

# 变更验证

- **类型检查**：`pnpm tc`（或 `tc:node` / `tc:cli` / `tc:web`）
- **测试**：`pnpm test [path/to/file.test.ts]`
- **代码检查与格式化**：对变更文件运行 `oxlint` 或 `pnpm run check:code-quality:changed`（完整 `pnpm lint` 较慢）；使用 `pnpm format` 格式化代码
- **设计系统**：`pnpm run lint:design-system` 查看完整的渲染器报告（非强制门禁）；上述变更行门禁为 CI 强制项
- **真实 Claude CLI 测试**：修改 Claude 结构化会话代码（`src/main/claude/claude-structured-*`）时，运行 `ORCA_REAL_CLAUDE_CLI_TEST=1 pnpm test src/main/claude/claude-structured-real-cli.test.ts src/main/claude/claude-structured-real-cli-fold.test.ts`；该测试使用你的真实 Claude 登录凭据

# 编写 Pull Request

填写 [`.github/pull_request_template.md`](./.github/pull_request_template.md)，面向从未见过该代码的审查者编写：

- 杜绝行话：使用通俗易懂的语言，避免内部缩写。
- 用户实际体验的前后对比。
- 修改的核心机制，而非仅仅陈述表面现象。
- 为何采用该方案而非考虑过的替代方案。

简明扼要地涵盖这四点。切勿充数或逐行复述 diff。

# 关键考量

## Worktree 安全

所有文件的读取和编辑必须始终使用主工作目录（worktree）。切勿跟随来自子代理结果中指向主仓库的绝对路径。

## 跨平台支持

Orca 面向 macOS、Linux 和 Windows 平台。所有平台相关的行为必须收敛在运行时检查后：

- **键盘快捷键**：严禁硬编码 `e.metaKey`。使用平台检查（`navigator.userAgent.includes('Mac')`）在 Mac 上使用 `metaKey`，在 Linux/Windows 上使用 `ctrlKey`。Electron 菜单加速键应使用 `CmdOrCtrl`。
- **界面快捷键标签**：Mac 上显示 `⌘` / `⇧`，其他平台上显示 `Ctrl+` / `Shift+`。
- **文件路径**：使用 `path.join` 或 Electron/Node 路径工具——切勿假定使用 `/` 或 `\`。
- **Windows 终端 shell**：`--shell` 决定终端本身运行的 shell；`--command` 则是键入到宿主所启动的 shell 中，因此通过 `command` 路由的 shell 选项会静默变成子进程。参见 [`docs/reference/windows-terminal-shell-selection.md`](./docs/reference/windows-terminal-shell-selection.md)。
- **Windows 安装/配置脚本**：setup/issue 命令运行器是 `.cmd` 批处理文件（除非脚本以 `#!` 开头）——切勿根据用户的终端 shell 偏好推导，且切勿从 Git Bash 面板中使用裸 `cmd.exe /c` 启动 `.cmd` 运行器（MSYS 会重写 `/c`）。参见 [`docs/reference/windows-setup-shell.md`](./docs/reference/windows-setup-shell.md)。
- **Windows 子进程**：必须通过 `src/shared/child-process/` 中的 `runProcess`/`spawnProcess` 启动——严禁直接调用 `child_process`。它固定了 `windowsHide`，拒绝 `shell: true`，并对 `.cmd`/`.bat` 参数进行编码，防止 `CommandLineToArgvW` 或 `cmd.exe` 篡改参数。已识别的 npm/pnpm `.cmd` shim 会解析为真实目标，使 spawn 完全跳过 `cmd.exe`；添加 shim 形式或排查问题前请参阅 [`docs/reference/windows-cmd-shim-resolution.md`](./docs/reference/windows-cmd-shim-resolution.md)。
- **Ripgrep**：Orca 为每个平台、WSL 以及 SSH 远端打包了内置的 `rg`。必须通过 `spawnBundledRipgrep`（main）或 `resolveRelayRipgrepCommand`（relay）生成进程，严禁使用裸 `'rg'`——Windows 会在 spawn 工作目录先于 PATH 进行裸名称解析。不要在本地添加 git/readdir 兜底逻辑；relay 的降级链仅用于部署未覆盖的宿主。
- **Windows 进程枚举**：通过 `src/main/windows/windows-process-table.ts` 读取进程表，严禁通过派生 `powershell.exe` 来读取。参见 [`docs/reference/windows-process-enumeration.md`](./docs/reference/windows-process-enumeration.md)。
- **Windows MSYS/Git Bash 面板**：其子进程会脱离每个 PTY 的作业对象，除非创建作业时未包含 `JOB_OBJECT_LIMIT_BREAKAWAY_OK`；在此修复之前构建的 `conpty.node` 可能会通过既有门禁。在修改每个 PTY 作业或调试 `windows-msys-job.win32.test.ts` 之前，请阅读 [`docs/reference/windows-msys-job-breakaway.md`](./docs/reference/windows-msys-job-breakaway.md)。
- **Windows 守护进程宿主迁移**：终端守护进程从 `%LOCALAPPDATA%` 下的应用运行时副本中运行，以便在自动更新后留存。在触碰该副本、其 exe 名称或 NSIS 卸载宏之前，请阅读 [`docs/reference/windows-daemon-host-relocation.md`](./docs/reference/windows-daemon-host-relocation.md)。
- **Windows EDR 信号**：不要随意添加 `-ExecutionPolicy Bypass`、`-EncodedCommand`、带有转义自由文本的 `cmd.exe /c`、逐操作派生解释器或运行时 `Add-Type` 编译，除非先阅读了 [`docs/reference/windows-edr-posture.md`](./docs/reference/windows-edr-posture.md)——行为型 EDR 会对每一项进行评分，即使签名也无法免除告警。关于发布字节的文件判决（杀软误报以及在用户接触前放行的供应商计划），参见 [`docs/reference/antivirus-prerelease-clearance.md`](./docs/reference/antivirus-prerelease-clearance.md)。
- **WSL 命令**：使用 `buildWslExecArgs` 构建 argv（始终使用 `--exec`——在 `--` 下，`wsl.exe` 会在每个参数中展开 `$name` 并静默重写脚本），并且任何需要解析 stdout 的命令都必须使用 `buildWslCapturedLoginShellCommand` 包裹，因为交互式登录 shell 会向 stdout 打印发行版横幅。参见 [`docs/reference/wsl-command-execution.md`](./docs/reference/wsl-command-execution.md)。
- **Linux 原生模块**：将 glibc 基线保持在 Ubuntu 20.04 / glibc 2.31。在较新构建机上从源码编译的模块可能引用基线不存在的符号版本，导致应用在启动时崩溃。参见 [`docs/reference/linux-glibc-compatibility.md`](./docs/reference/linux-glibc-compatibility.md)；如果打包的原生二进制文件需要更高版本的 glibc，打包流程将失败。

## 原生依赖安装

常规的 `pnpm install` 仅覆盖当前宿主系统和 CPU 架构。在为其他架构打包之前（包括默认构建 x64 和 arm64 的 `pnpm build:mac`），请运行 `pnpm install:release`。electron-builder 在缺少 `extraResources` 资源时仅发出警告，因此 `beforePack` 保护能够将不完整的安装转换为构建失败，防止生成损坏的产物；参见 [`docs/reference/pnpm-install-policy.md`](./docs/reference/pnpm-install-policy.md)。

## SSH 使用场景

所有更改必须充分考量 SSH 使用场景，不得假定仅在本地执行。在修改任何涉及报告、停止或列出远程工作的逻辑之前，请遵循 [`docs/reference/ssh-execution-boundary.md`](./docs/reference/ssh-execution-boundary.md)：执行宿主完全拥有涉及执行的一切，失联绝不能作为进程退出的依据——状态判决词汇必须严格为 `live` / `unverifiable` / `exited`，严禁使用任何同义词。

## 文件夹工作区场景

所有更改必须同时考虑文件夹工作区和 git worktree。不得假定每个工作区都是 git worktree。

## Agent 状态管理

执行宿主在 hook 服务器中单点拥有 Agent 状态，所有读取方（侧边栏、`worktree ps`、移动端、仪表盘）都订阅该状态存储。在添加生产方、缓存或读取侧优先级规则前，请阅读 [`docs/reference/agent-status-store.md`](./docs/reference/agent-status-store.md)：新生产方写入该存储，读取方仅保留展现策略。

## Agent 终端屏幕检测

用于读取 Agent CLI 在终端绘制内容（就绪状态、阻塞提示、空闲状态）的规则，必须针对捕获的转录记录编写，而不能凭记忆中的屏幕画面。使用 [`docs/reference/agent-pty-transcript-capture.md`](./docs/reference/agent-pty-transcript-capture.md) 进行录制，该工具能保持转义字符和换行完整，并在提交到 git 前脱敏账户标识符。Antigravity 的就绪检测在缺乏转录记录的情况下已有五次失败尝试；在修改之前，请阅读 [`docs/reference/antigravity-readiness-evidence.md`](./docs/reference/antigravity-readiness-evidence.md)。

## 远程通信线路兼容性

客户端与远程 Orca 服务器是独立更新的，版本混用属于常态。在修改配对客户端与宿主交换的任何内容（RPC 参数、流帧或双方发布的内容）之前，请遵循 [`docs/reference/remote-wire-compatibility.md`](./docs/reference/remote-wire-compatibility.md)。新增可选字段是安全的；新增流操作码必须经过能力协商，因为旧解码器会静默丢弃未知操作码；改变宿主发布的内容即使没有线路结构变化也会影响旧客户端。

## Git 二进制兼容性

Orca 在本地、WSL 和 SSH 宿主上运行用户的 Git 二进制文件，各环境版本可能不同。将 Git 2.25 视为核心工作流基线，并遵循 [`docs/reference/git-compatibility.md`](./docs/reference/git-compatibility.md)。

添加或更改 Git 命令时：

- 检查每个子命令和选项是在何时引入的。对于较新的行为，保留基线兼容的降级逻辑或安全降级。
- 使用带有严格“不支持错误”断言的 `GitCapabilityCache`，避免重复尝试已知无效的命令。不要仅仅依赖 `git --version`；`simple-git` 之类的包装器无法消除宿主版本差异。
- 将能力状态隔离到执行 Git 的宿主：本地、WSL 发行版、SSH 服务商或中继连接。在测试中覆盖首次回退、后续缓存调用、并发探测以及相关宿主隔离。
- 保持 PR CI 中真实二进制兼容性契约的时效性。引入较新的 Git 功能时，添加其版本边界，确保首选命令和降级方案都在具有代表性的 Git 发行版上运行。
- 保留在子命令之前以全局 Git 选项（如 `-c`）开头的命令，包括创建 worktree 拉取时使用的自动维护抑制选项。

## Git 扫描安全

- 严禁枚举每个 ref 然后对每个 ref 执行一次 `git ls-tree -r` 或 `git show`。这种 ref × tree 的扇出操作会在下游 `sort -u` 或搜索开始前占用数千兆字节的内存。
- 源码搜索优先使用 `rg` 扫描检出文件。对于历史记录或 ref，使用具体命名的 ref、显式命名空间/路径、`--max-count` 和有界输出；切勿将无限制的 `--all` 扫描作为第一步诊断。
- 保持仓库级命令限定在当前仓库和工作区内。如果确实需要无界扫描，必须先评估 ref 数量、说明开销并获取确认。

## Git 服务商兼容性

源码控制和审查相关修改必须兼顾 GitLab 及其他受支持的 Git 服务商，不仅限于 GitHub。平台专属逻辑必须置于显式检查后，通用审查概念避免使用 GitHub 专属命名。

## GitHub CLI 使用规范

注意用户的 `gh` CLI API 速率限制——尽可能批量处理请求并避免非必要调用。所有代码、命令和脚本必须兼容 macOS、Linux 和 Windows。

---

# 任务持久化记忆：WSL 环境下 Antigravity 原生账号管理支持

## 1. 问题背景与现象复现
- **截表现象（来自截图 `orca-paste-1791277650076-390a9ea7-e96a-4a21-81db-d0b6a4554394.png`）**：
  - 在 Orca 的 **设置 > 账号（Settings > Accounts）** 页面中，进入 **Antigravity** 账号设置区域（`accounts-antigravity`）。
  - 当选择目标运行环境为特定的 WSL 发行版（例如 `WSL Ubuntu-24.04`）时：
    - 标题提示：`Manage the native agy account on WSL Ubuntu-24.04.`（在 WSL Ubuntu-24.04 上管理原生 agy 账号）
    - 出现红色错误告警：`Antigravity account management for a client-selected WSL distro is not supported yet. Use agy inside that distro; the host account was not changed.`（暂不支持客户端选定的 WSL 发行版的 Antigravity 账号管理；请在该发行版内直接使用 agy；宿主机账号未变更）
    - 状态：无法加载或管理账号，显示 `[Retry]`（重试）按钮。

- **根本原因排查**：
  - **服务入口硬编码限制**：在 [`src/main/antigravity/native-account-host.ts`](file:///home/turmony/projects/orca-feature/src/main/antigravity/native-account-host.ts) 中，函数 `getAntigravityAccountService(target)` 显式判断并抛出异常：
    ```typescript
    if (target.runtime !== 'host' || target.wslDistro) {
      throw new Error(
        'Antigravity account management for a client-selected WSL distro is not supported yet. Use agy inside that distro; the host account was not changed.'
      )
    }
    ```
  - **PTY 启动准备跳过 WSL**：在 [`src/main/antigravity/native-account-launch.ts`](file:///home/turmony/projects/orca-feature/src/main/antigravity/native-account-launch.ts) 的 `prepareAntigravityAccountForLaunch` 函数中，直接排除了 WSL 目标：`if (agent !== 'antigravity' || args.connectionId || args.isWsl) return`。
  - **架构说明文档**：[`docs/reference/antigravity-native-accounts.md`](file:///home/turmony/projects/orca-feature/docs/reference/antigravity-native-accounts.md) 中指出：“Windows Orca 面向选定 WSL 发行版的操作在适配器通过验证前明确保持未支持状态”。

## 2. 解决目标与预期成果
1. **完整支持 WSL 发行版目标的 Antigravity 账号管理**：
   - 扩展 `getAntigravityAccountService`（或对应目标路由分发机制），支持 `{ runtime: 'wsl', wslDistro: string | null }` 目标。
   - 实现经过安全验证的 WSL 凭据后端适配器：
     - WSL 内部运行的 Antigravity CLI（`agy`）将 OAuth 凭据以文件形式保存在 `~/.gemini/antigravity-cli/antigravity-oauth-token`。
     - 安全地读取与写入目标 WSL 发行版内的凭据文件（严格遵循 WSL 路径解析与执行标准）。
   - 账号保险库（Vault）实现按目标运行环境/发行版隔离，防止 WSL 账号与宿主机 Host 账号产生状态冲突或数据覆盖。
2. **支持 WSL 下的 PTY 终端启动账号准备**：
   - 更新 `prepareAntigravityAccountForLaunch`，确保在指定 WSL 发行版启动 `agy` 时正确校验并切换至选中的账号。
3. **完善的测试覆盖与质量验证**：
   - 编写单元测试，覆盖 WSL 目标下的凭据读取、写入、账号列表、添加当前账号、切换选择、删除账号等全流程。
   - 覆盖发行版不存在、权限异常（严格要求 `0600` / 仅所有者可读写）、损坏文件或并发冲突时的健壮错误处理。
   - 严格通过项目的各项代码质量门禁：`pnpm tc`（TypeScript 类型检查）、`pnpm test`（单元测试）、`oxlint` / `pnpm run check:code-quality:changed`。
4. **向 GitHub 上游仓库提交 PR**：
   - 遵循项目规范，按照 [`.github/pull_request_template.md`](file:///home/turmony/projects/orca-feature/.github/pull_request_template.md) 编写清晰明了的 PR 描述并提交给 `stablyai/orca` 仓库。

## 3. 架构设计与技术约束
- **WSL 文件访问与命令执行**：
  - 在 Windows 环境下，WSL 路径应通过 `getWslHomeAsync(distro)` 或标准的 WSL UNC 路径（如 `\\wsl.localhost\<distro>\...`）配合 `buildWslExecArgs` 进行安全访问，严禁使用裸 `wsl.exe` 拼接未转义命令。
  - 必须严格校验凭据文件权限（非 Windows 平台检查 `stat.mode & 0o077 === 0`，防止越权读取）。
- **跨平台安全性**：
  - 所有平台相关逻辑需通过运行时检测隔离，确保在 macOS、Linux 以及 Windows 上均能安全降级或优雅运行。
- **并发与冲突控制**：
  - 保持现有的 `CONFLICT` 检测与原子写入机制（`writeCredentialFileAtomic`），防止在并发读写或外部刷新时覆盖有效凭据。
