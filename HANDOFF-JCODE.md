# jcode-in-orca 桌面应用 — HANDOFF（2026-06-22）

> 给 compact 后 / 新 session 接手用。读完这份就能继续。用户 = Srain（非技术、讨厌终端、中文、偏好稳定可双击的 GUI app）。

## 0. 一句话目标
给非技术用户做一个 **Claude-app 式聊天界面**的 AI 编码 agent 桌面应用，基于 fork 的 orca，后端是 jcode（`jcode run --ndjson`），含 **brain-local/hands-remote**（模型在本机、bash 在远程 SSH）。

## 1. 资产位置
- **orca fork（主体）**：`/Users/vinny/orca-study`，分支 **`jcode-integration`**（clone 自 stablyai/orca @ 988c070，MIT）。所有 orca 侧的 jcode 集成都在这。
- **jcode fork（后端二进制）**：`/Users/vinny/jccode`（Rust）。二进制软链 `/Users/vinny/.cargo/bin/jcode` → `~/jccode/target/debug/jcode`。含 `--remote-exec`（brain-local）+ `-C` remote-exec 感知（commit 0f0028d）。
- **打包好的 app（用户日常用这个）**：**`/Applications/Orca.app`**（从 orca-study `build:unpack` 产出，Node 24 构建，ad-hoc 签名）。
- **旧 Tauri 应用 jccode**：`/Users/vinny/jcode-desktop`（原始聊天优先 app；是"转回 jccode"那条备选方向的现成底座）。

## 2. 构建 / 重打包（关键，务必照做）
- **dev 模式**：`pnpm dev`（electron-vite）—— **脆，窗口会消失**；renderer 改动热重载，**main 进程改动要完整重启**（Cmd+R 不够）。不建议给用户用。
- **打包正式 app（必须用 Node 24）**：默认 `node` 是 `/Users/vinny/.local/bin/node`=v22.23（会让 `node:sqlite` 的 afterPack 校验失败）；**v24.11 在 `/usr/local/bin/node`**。命令：
  ```
  cd /Users/vinny/orca-study && export PATH="/usr/local/bin:$PATH" && /usr/local/bin/node /Users/vinny/.local/bin/pnpm run build:unpack
  ```
  产物 `dist/mac-arm64/Orca.app` → 安装：`pkill -f "Orca.app/Contents/MacOS/Orca"; rm -rf /Applications/Orca.app && cp -R /Users/vinny/orca-study/dist/mac-arm64/Orca.app /Applications/Orca.app; open /Applications/Orca.app`（本地构建无下载隔离，双击直接开）。
- **jcode 二进制改动**：`cd /Users/vinny/jccode && cargo build` 即更新软链二进制；**app 调的是外部 jcode，不用重打包 orca**。
- **验证门**：`/Users/vinny/.local/bin/pnpm run typecheck` + `... run lint:switch-exhaustiveness`。（`pnpm run lint` 全量里 check-styled-scrollbars 对 3 个 chat-pane 文件预存失败，与我们无关。）

## 3. 已做出来 & 已验证（orca jcode-integration 关键提交）
聊天核心(M0–M3)：注册 jcode agent、气泡视图、工具卡片+diff+流式+多轮(--resume)+停止、brain-local。
之后：聊天 tab 头+切换/worktree切换不丢；Claude 风布局；中文 IME 修复；**对话磁盘持久化**(`src/main/jcode/jcode-conversation-store.ts`)+ Recent chats + 左侧项目栏「JCODE 聊天」可重开；**自定义 provider**(设置→AI提供商账户→自定义 Provider → `jcode provider add --api-key-stdin` → `--provider-profile`)；**附件**(原生选择器/文本/拖拽/跨设备 scp，**图片二进制安全**+25MB上限)；**`/` 菜单**(orca 快捷命令 + 项目级 `.claude/skills`)；jcode 强制进所有启动器(`preflight.ts` ALWAYS_AVAILABLE_LOCAL_AGENT_IDS)；**自动更新已关**；**远程 Git 项目修复**(`jcode-remote-exec.ts` 处理 worktree-scope，不再 ENOENT)；**报错人话**(`jcode-error-messages.ts`)；关 tab 杀进程；JCODE_BIN 走 PATH 解析。
jcode 二进制：`--remote-exec` + `-C` 在 remote-exec 下只设远程目录(不本机 chdir)。
**用户已确认：本地 + 远程 Git 项目聊天都能用了（"消息没什么问题了"）。看图也实测成功（用户："测试成功"）。**

**2026-06-22 收尾**：三个功能已提交 —— orca-study `a20a388`(jcode-integration)、jccode `feat/run-image-vision` 分支 `6571316`(从 main 切出)。另在 `~/orca-study/.claude/skills/` 建了 5 个开发流程技能(rebuild-app / verify-gates / add-chat-feature / jcode-kernel-change / probe-jcode)——**注意 `.gitignore:105` 把 `/.claude/skills/` 排除了,技能只在本机磁盘、不进 git(orca 约定:项目技能本地私有);jcode 的 `/` 菜单按文件系统发现,照常生效**。/Applications 的 app 是看图实测那次的构建;之后只做了纯重构(model picker 拆到 `ChatModelPicker.tsx` 过 max-lines 闸,行为不变),想让二进制==已提交源码可再跑一次 rebuild-app(非必须)。

## 4. 待办 / 已知问题
- **✅ 远程 Git 项目 + 附件 + jcode 工具：已验证真能在 spark 上跑**(用户实测 bash/identify 都出结果)。自定义 provider 真实端点也能用(用户实测远程项目里工具在跑)。
- **✅ 问题2 — 详细模型选择器(2026-06-22 完成,orca 侧)**:composer 模型 chip 现在由真实目录驱动 `jcode model list --json`(新 IPC `jcodeProviders.listModels` → `JcodeModelCatalog {provider,selected_model,models[],routes[]}`)。按 provider 分组、每个模型显示**可用性**(routes[].available；不可用标"需登录")、当前模型打勾、底部"刷新模型列表"、"Auto → <真实解析模型>"。`routeProviderToId` 把显示名映射回 `-p` id;选模型同时定 provider+model。catalog 里没有的 provider(gemini/openrouter…)收进"更多 Provider"子菜单。**"Auto"现在真 auto**:`buildArgs` 默认 `-p auto`(原来硬编码 openai)+ ChatPane 默认 prop 改 'auto'。文件:`chat-pane/jcode-providers.ts`(catalog hook+分组+映射)、`ChatComposer.tsx`(整个 chip 重写为 DropdownMenuItem+Check)、`main/ipc/jcode-providers.ts`(listModels,顺手把硬编码 JCODE_BIN 换成 resolveJcodeBin)。
- **✅ 问题1 — 看图(2026-06-22 完成,jcode 内核 + orca 双侧)**:发现内核**早就能收图**(ACP 通道证明 `run_once_streaming_mpsc` 接受 `images: Vec<(mime,base64)>` 并建 `ContentBlock::Image`),只是 `run` 没开口子。改动:jcode 加 `run --image <PATH>`(可重复)→ args.rs/dispatch.rs/commands.rs(`load_images_for_run` 读文件+magic-byte 猜 mime+base64,只在 ndjson 首轮发图)。**已实测通过**:`jcode run --image /tmp/jcode-vision-test.png --ndjson "..."` → 模型准确读出"VISION-OK-42 / 红色矩形 / 蓝色圆"。orca 侧:`jcode-attachments.ts` 加 `isVisionImagePath/extractImagePaths/nonImageAttachments`(png/jpg/jpeg/gif/webp);`jcode-chat-session.ts` startTurn 把图片附件抽出来走 `--image`(本地路径,remote-exec 也读本地,不再 scp/不再 weave),其余附件照旧;buildArgs 加 imagePaths 参数。`cargo build` 已更新软链二进制。
- **✅ 问题3 — MCP / 连接器(2026-06-22 完成,orca 侧;内核早有)**:发现 jcode **早就全套 MCP**(stdio-only:`McpServerConfig{command,args,env,shared}`,配置 `~/.jcode/mcp.json` Claude-Desktop 格式,自动从 `~/.claude/mcp.json`+Codex 导入,MCP 工具已接进 agent 工具表;用户已有 vault-write+node_repl)。orca 侧加管理界面:新 IPC `jcodeMcp.get/set`(`main/ipc/jcode-mcp.ts` 读写全局 `~/.jcode/mcp.json`,写前备份 .bak)+ 设置页"连接器/MCP"区(`AccountsPane.tsx` JcodeMcpSection:列/增/删,字段 name/command/args/env)+ composer"+菜单"的 Connectors→跳设置该区、Plugins→技能页(不再是 Soon)。**远程/托管连接器(IBKR 这种)走 stdio 桥**:command=npx args=[mcp-remote, https://…]。MCP 工具调用本来就以 tool 事件流过 ndjson,会在聊天里显示。
- **自定义 provider 真实端点**：链路已用假 provider 验证打到端点；用户真实 URL+key 用起来了(远程项目工具在跑)，可视为通。
- QA 审计剩余(次要)：`listConversations` 每次重读所有文件→历史多会卡(应加索引)；`/` 只在输入框句首触发；远端 `/tmp/orca-jcode-attachments` 不清理；无凭证时 provider 报错引导差；未发送草稿关 tab 丢失；SSH 断时附件被丢但气泡仍显示"已附加"；流式中关 tab 丢事件。完整清单见本 session 的 QA workflow 输出。

## 5. ⏳ 悬而未决：方向决策
**继续打磨 orca vs 转回 jccode。** 之前代码审计 + 市场调研(`/Users/vinny/jcode-desktop/{ORCA-CHATFIRST-AUDIT.md,AI-CODING-LANDSCAPE-2026.md}`)都指向 **jccode 更适合做纯聊天产品**(orca 是终端复用器，掰成聊天优先一直在逆架构；jccode 天生聊天优先)。用户当时选"先修 bug 再看"。**现在 bug 修得差不多了 → 可重新评估。**

## 6. 协作铁律（记忆里也有）
- **不要用 computer-use 截图验证**，用户自己验（且本机点击有 Dock 命中 bug）；崩溃用读日志诊断。
- 命令给**纯净可复制**(无行内 `#` 注释)。
- 偏好 GUI / 非技术语言 / 中文。
- 自动更新别让用户点(已在代码关掉；未签名版本也装不上)。

## 7. 2026-06-22 closeout validation evidence
- 当前分支：`jcode-integration`。收尾提交已覆盖 scrollbar gate、localization gate、jcode session store 拆分、jcode binary resolution、remote attachment lifecycle cleanup/hardening、remote upload command exit-code 校验、附件测试 fixture 拆分。
- `export PATH="/usr/local/bin:$PATH"; /usr/local/bin/node /Users/vinny/.local/bin/pnpm run typecheck`：PASS。
- `export PATH="/usr/local/bin:$PATH"; /usr/local/bin/node /Users/vinny/.local/bin/pnpm run lint`：PASS；包含 `lint:switch-exhaustiveness`、`check:styled-scrollbars`、`verify:localization-catalog`、`verify:localization-coverage`。
- `export PATH="/usr/local/bin:$PATH"; /usr/local/bin/node /Users/vinny/.local/bin/pnpm exec vitest run --config config/vitest.config.ts src/main/jcode/jcode-attachments.test.ts src/main/jcode/jcode-remote-exec.test.ts`：PASS，2 files / 16 tests。
- `export PATH="/usr/local/bin:$PATH"; /usr/local/bin/node /Users/vinny/.local/bin/pnpm run test`：FAIL only in non-jcode PTY tests during full-suite concurrency/resource load: `src/main/daemon/node-pty-fd-leak.test.ts` timed out, `src/main/daemon/shell-ready.test.ts` had 3 marker assertions, `src/main/pty/omp-shell-wrapper.node-pty.test.ts` had 3 bash PTY timeouts. Focused rerun of those exact 3 files passed: 3 files / 27 tests. Treat as documented full-suite PTY flake until reproduced outside concurrent full run.
- `export PATH="/usr/local/bin:$PATH"; /usr/local/bin/node /Users/vinny/.local/bin/pnpm exec vitest run --config config/vitest.config.ts src/main/daemon/node-pty-fd-leak.test.ts src/main/daemon/shell-ready.test.ts src/main/pty/omp-shell-wrapper.node-pty.test.ts`：PASS，3 files / 27 tests.
- `export PATH="/usr/local/bin:$PATH"; /usr/local/bin/node /Users/vinny/.local/bin/pnpm run build:unpack`：PASS. Built `dist/mac-arm64/Orca.app`, version `1.4.89-rc.0`, size about `1.0G`, ad-hoc signed, notarization skipped by config.
- Manual GUI smoke was not performed in this pass. User-side checks still recommended before daily use: open rebuilt app, start jcode local chat, start remote SSH project chat, send image attachment, verify model picker, verify MCP settings read/write.
- Remote/fork hygiene: `git remote -v` still shows `origin=https://github.com/stablyai/orca` for fetch and push. No user-owned fork remote is configured, so do not push from this checkout until a fork remote is added.
- Product-direction decision: keep this Orca fork as the current closeout target while SSH project management, worktrees, review UI, and existing Orca shell are core value. Re-open the jcode-desktop direction only if the durable product narrows to a Claude-app-style chat shell and Orca's terminal/worktree architecture becomes net drag again.
- Residual non-blocking limitation: remote attachment upload assumes POSIX remote tools and paths (`/tmp`, `mkdir`, `base64 -d`, `rm`). Unsupported SSH targets fail closed and report attachments as not copied; no live SSH integration test was run in this closeout pass.
