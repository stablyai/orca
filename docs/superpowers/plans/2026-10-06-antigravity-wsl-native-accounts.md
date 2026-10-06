# Antigravity WSL Native Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows Orca 安全管理指定 WSL 发行版的原生 agy 账号，并在实际启动前核实选定账号。

**Architecture:** 复用现有 AntigravityAccountService 和加密保险库格式，通过独立 WSL 后端在
guest 内完成文件访问。目标以发行版、UID、HOME 绑定，Windows 保险库按目标隔离；客户端
仅收到摘要，RPC 能力协商与启动检查使用同一执行拥有方。

**Tech Stack:** TypeScript、Electron、Vitest、React、shadcn、WSL POSIX shell、现有
runProcess/runWslProcess、getSecretStore 和 Windows ACL 实现；不新增运行时依赖。

**Spec:** [已批准设计](../specs/2026-10-06-antigravity-wsl-native-accounts-design.md)。执行者先读设计、
本计划、项目 AGENTS.md；本计划补充接口和任务顺序，不放宽设计要求。

## Global Constraints

- 原生凭据上限 `64 KiB`，保险库上限 `4 MiB`，内部输入/输出上限各 `192 KiB`。
- 凭据和 guest 锁文件严格 `0600`，新私密目录 `0700`，锁等待最多 `2 秒`。
- 服务端操作预算 `15 秒`，客户端 RPC 等待 `20 秒`；排队与权限保护计入同一 deadline。
- 新能力为 `accounts.antigravity-native-wsl.v1`；只有 Windows 实现宿主发布。
- Host 保险库路径保留；WSL 路径为 `userData/antigravity-accounts/wsl/<scopeHash>/vault`。
- 所有测试和应用启动设置 `ORCA_BACKGROUND_LAUNCH=1`；不显示或激活测试窗口。
- 使用 runWslProcess/buildWslExecArgs、runProcess/spawnProcess，禁止裸命令拼接、shell: true、
  token argv/env/log、PowerShell 包装、Node/Python guest 依赖或明文保险库降级。
- 现有账号服务队列和 codec 保留；无选择不自动写凭据，外部身份变化阻止启动，不自动回滚。
- 弱加密、坏保险库、不安全路径、权限不明、目标不可达明确失败，不能作为空账号列表。
- 兼顾 Host、WSL、配对运行时、SSH、文件夹工作区与 git worktree；不回退到客户端执行。
- UI 先读 docs/STYLEGUIDE.md；保持现有原语、token、WSL 用量禁用及正常 agy 登录流程。
- 文件名按业务职责命名；不增加 max-lines 抑制；类型转换遵守 AGENTS.md 的 SAFETY 要求。

## Review Focus

1. 目标在列表与点击之间改变：拒绝修改而不是写入另一发行版，测试由任务 2、6、7 覆盖。
2. 同一用户的 CLI 原地刷新文件：不能返回混合内容或旧快照，测试由任务 5、6 覆盖。
3. Windows ACL 探测缓慢或失败：不阻塞主线程、不迟到发布，测试由任务 3、4 覆盖。
4. 设置页换目标后旧请求完成：不能覆盖新页面，测试由任务 7 覆盖。
5. WSL 启动配置在准备后漂移：检查目标必须等于真正 spawn 的目标，测试由任务 8 覆盖。

## Git 管理与执行前检查

当前仓库已有 Git，分支为 `feat/wsl-antigravity-accounts`；origin 指向 turmony/orca，
upstream 指向 stablyai/orca。本次计划提交只包含 `.gitignore`、本计划和已批准设计。
原有 AGENTS.md 修改保留，不在计划提交中；不执行 git init、重建远端、reset、强推或全量暂存。

后续实现继续使用用户指定的 `/home/turmony/projects/orca-feature`。每个任务仅暂存其文件，
通过验证后按任务提交；在计划中勾选步骤并把记录纳入同一个任务提交。若开始执行时 HEAD
或工作目录状态已改变，先重新核对差异，不自动丢弃任何现有修改。

预检：记录 `git status --short` 和 HEAD；确认 Node 24、package.json 指定的 pnpm 12.8.1。
本次规划时 Node 可用，pnpm 和 node_modules 尚未准备，产品测试没有运行。实现前按项目
安装说明准备 pnpm，并运行 `pnpm install --frozen-lockfile`；跨架构打包使用 pnpm install:release。
不能通过关闭 hooks 或 lint 绕过安装问题。

先运行以下相关基线；只有基线通过或原有失败已准确记录后才进入产品修改：

```bash
ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/antigravity src/main/wsl/wsl-runner.test.ts src/shared/secure-file.test.ts src/renderer/src/runtime/runtime-antigravity-accounts-client.test.ts src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx
```

后文 POSIX 验证命令均加 `ORCA_BACKGROUND_LAUNCH=1` 前缀。Windows PowerShell 在同一
会话先设置 `$env:ORCA_BACKGROUND_LAUNCH = '1'`，再运行 pnpm；不能把 POSIX 环境赋值语法
直接复制到 PowerShell。下列路径相对当前工作目录，不访问其他 checkout。

## 文件职责与依赖顺序

| 任务 | 核心文件 | 职责 |
| --- | --- | --- |
| 1 | src/main/wsl/wsl-runner.ts | 独立 stdin、取消与截断结果 |
| 2 | src/main/antigravity/native-wsl-account-target.ts；native-account-operation.ts | 目标、绑定、操作预算 |
| 3 | src/shared/secure-file-publication.ts；secure-path-windows-acl.ts | 严格异步密文发布，复用权限实现 |
| 4 | src/main/antigravity/native-account-store.ts；native-account-service.ts | 异步 store 与操作上下文 |
| 5 | src/main/antigravity/native-wsl-credential-{protocol,script,backend}.ts | guest 协议与凭据访问 |
| 6 | src/main/antigravity/native-account-host.ts | 目标服务注册表、动作路由与恢复 |
| 7 | src/shared/protocol-version.ts；RPC/schema；现有设置组件 | 能力、绑定、UI 请求代次 |
| 8 | src/main/antigravity/native-account-launch.ts；三个现有启动入口 | 实际 spawn 目标检查与固定 |
| 9 | WSL 集成测试；参考文档；PR 描述 | 真实证据、整体门禁与提交准备 |

任务 1、2、3 各自可验证；按编号实施，使接口依赖清晰。任务 4 使用 2、3，任务 5
使用 1、2，任务 6 使用 4、5，任务 7、8 使用 6，任务 9 验收整体功能。

## Task 1: 给 WSL 执行器增加独立数据 stdin

**Files:** Modify `src/main/wsl/wsl-runner.ts`；Test `src/main/wsl/wsl-runner.test.ts`。
同步更新 Claude、Codex accounts、skill discovery 三处既有 WslResult 测试工厂，补充 outputTruncated。

**Interfaces:** Consumes 既有 ProcessSpec.input/signal/killOnOutputLimit。
Produces WslSpec 的 `input?: string`、`signal?: AbortSignal`、`killOnOutputLimit?: boolean`，
WslResult 的 `outputTruncated: boolean`；runWslProcess 的签名与已有默认行为保持。

- [x] **Step 1: 写失败测试。** 以现有 runProcessMock 测试为基础，增加普通程序和短脚本
  传 input、无 input 长脚本、带 input 超长脚本、取消、stdout/stderr 截断各项断言：

  ```ts
  await runWslProcess({ distro: 'Ubuntu', loginPath: 'none', script: 'cat', input: 'payload\n' })
  expect(runProcessMock.mock.calls.at(-1)?.[0].input).toBe('payload\n')
  expect(lastArgv()).toContain('--exec')
  expect(lastArgv()).not.toContain('payload\n')
  ```

- [x] **Step 2: 验证失败。** `pnpm test src/main/wsl/wsl-runner.test.ts`；预期新增 input 或
  outputTruncated 断言失败，而不是因为原生安装或测试启动失败。
- [x] **Step 3: 实现传输。** 保留无 input 的脚本 stdin 降级；有 input 时脚本必须放 argv，
  超预算在 spawn 前失败。input 不参与 fullLine、env、日志，signal/超限终止显式下传。
  outputTruncated 使用底层结果，不从输出长度猜测。
- [x] **Step 4: 验证通过。** 重跑任务测试并执行 `pnpm tc:node`；确认既有 cwd、环境、长脚本
  和 --exec 用例仍通过，对新增路径跑变更代码质量检查。
- [x] **Step 5: 提交。** 只暂存本任务两文件与计划勾选；提交 `feat(wsl): support separate stdin payloads`。

## Task 2: 解析 WSL 账号目标和操作预算

**Files:** Create `src/main/antigravity/native-account-operation.ts`、
`native-account-operation.test.ts`、`native-wsl-account-target.ts`、`native-wsl-account-target.test.ts`。
Modify/Test `src/main/wsl/wsl-guest-environment.ts`、`wsl-guest-environment.test.ts`。

**Interfaces:** Produces 以下类型和函数；UID 数值、home 为当前登录 HOME，canonicalHome
为实际路径，凭据路径由该已验证目录生成，authorityId 为 SHA-256 的小写十六进制字符串。

```ts
type AntigravityAccountOperation = { deadline: number; signal: AbortSignal }
withAntigravityAccountOperation<T>(run: (operation: AntigravityAccountOperation) => Promise<T>): Promise<T>
type ResolvedAntigravityWslTarget = { distro: string; uid: number; home: string; canonicalHome: string; authorityId: string; credentialPath: string }
resolveAntigravityWslTarget(target: AntigravityAccountTarget, operation: AntigravityAccountOperation): Promise<ResolvedAntigravityWslTarget>
getWslGuestEnvironment(distro: string | undefined, budgetMs?: number, options?: { fresh?: boolean; signal?: AbortSignal }): Promise<WslGuestEnvironment | null>
```

- [x] **Step 1: 写失败测试。** 用已有 fenced probe mock 形状，测试默认目标从真实
  WSL_DISTRO_NAME 得到 Ubuntu，列出顺序不影响选择；显式名字大小写别名具有同一
  authorityId。UID/HOME 改变使 authorityId 改变；非 Windows、超时、坏身份包拒绝。
  fake timers 断言 deadline 是开始时间加 15_000，过期 signal.aborted 为 true。
- [x] **Step 2: 验证失败。** `pnpm test src/main/antigravity/native-account-operation.test.ts
  src/main/antigravity/native-wsl-account-target.test.ts src/main/wsl/wsl-guest-environment.test.ts`。
  预期新模块/新 fresh 行为尚不存在。
- [x] **Step 3: 实现目标与预算。** 默认目标只读探测后固定发行版；fresh 探测不采用旧 HOME
  缓存，继续使用既有围栏、退出状态和子进程规则。作用域哈希输入固定为
  `JSON.stringify(['v1', 'wsl', distro.toLowerCase(), uid, canonicalHome])`。
  对不安全/不一致 HOME 拒绝，不用 Windows HOME 或 UNC stat 猜测 guest 身份。
  operation 用 AbortController 管理 15 秒，finally 清理 timer；过期前后不得启动新提交。
- [x] **Step 4: 验证通过。** 重跑三测试文件及 `pnpm tc:node`；现有 WSL 环境缓存用例保持。
  为阻塞/打印 banner 的登录 shell 添加受限 budget 与 fence 验证，不能继承无限等待。
- [x] **Step 5: 提交。** 只暂存上述文件与计划；提交 `feat(antigravity): resolve bound WSL account targets`。

## Task 3: 复用权限代码实现严格的异步密文发布

**Files:** Create `src/shared/secure-file-publication.ts`、`secure-file-publication.test.ts`。
Modify/Test `src/shared/secure-file.ts`、`secure-path-windows-acl.ts`、
`secure-file.test.ts`、`secure-path-windows-acl.win32.test.ts`。
提取 `windows-current-user-sid.ts` 并增加对应测试，复用同步/异步 SID 缓存且保持 ACL 文件行数门禁。

**Interfaces:** Consumes task 2 operation 的结构，复用既有 ACL 规划、SID 与验证。
Produces `writeProtectedFileAtomic(path: string, contents: Buffer, operation: { deadline: number;
signal: AbortSignal }): Promise<void>` 和
`restrictWindowsPath(path: string, isDirectory: boolean, operation: { deadline: number;
signal: AbortSignal }): Promise<boolean>`；由 secure-file.ts 导出严格发布入口。

- [x] **Step 1: 写失败测试。** 临时目录内测试 Buffer 字节完整、唯一独占临时文件、短写、
  file fsync 失败、父目录保护 false、临时文件保护 false、提交前取消保留旧文件：

  ```ts
  await expect(writeProtectedFileAtomic(path, nextCiphertext, expiredOperation)).rejects.toThrow()
  expect(await readFile(path)).toEqual(previousCiphertext)
  ```

  另测 published ACL 验证失败返回“需核实”错误，不宣称旧文件保持；Windows 目录 fsync
  不支持时不误报全部操作失败。权限测试沿用当前管理员/SYSTEM 信任范围。
- [x] **Step 2: 验证失败。** `pnpm test src/shared/secure-file-publication.test.ts
  src/shared/secure-file.test.ts`；真实 Windows ACL 测试留到 Windows 环境执行。
- [x] **Step 3: 实现严格发布。** 从既有实现提取/复用权限与 staging 机制，不能另写 SDDL
  parser。用 fs/promises 和异步 runProcess，SID 冷启动也不得同步阻塞主线程。
  把剩余 deadline 与 signal 贯穿每个 ACL 调用，核实父目录后独占创建临时文件，保护后
  写 Buffer、同步、替换、验证。旧 best-effort 入口保持默认语义；清理仅限本次临时文件。
- [x] **Step 4: 验证通过。** 重跑任务测试和 `pnpm test src/shared/secure-file-fsync-flags.test.ts
  src/shared/secure-file-coarse-ctime.test.ts`；测试取消后的后续 tick 不再发生 rename。
  `pnpm tc:node` 和变更代码检查通过。
- [x] **Step 5: 提交。** 提交 `feat(security): add protected asynchronous file publication`，仅包含本任务文件。

## Task 4: 让现有保险库和账号服务支持异步保护

**Files:** Modify/Test `src/main/antigravity/native-account-store.ts`、`native-account-store.test.ts`、
`native-account-service.ts`、`native-account-service.test.ts`、`native-account-test-fixtures.ts`、
`native-account-launch.ts`、`native-account-launch.test.ts`。

**Interfaces:** Consumes task 2 operation/target 和 task 3 publisher。
AntigravityAccountStore 变为 `read(operation?: AntigravityAccountOperation):
AntigravityAccountVault | Promise<AntigravityAccountVault>`，`write(vault: AntigravityAccountVault,
operation?: AntigravityAccountOperation):
void | Promise<void>`。工厂增加可选 `options: { authority?: ResolvedAntigravityWslTarget }`。
WSL vault 密文 JSON 的 `scope` 为 `{ version: 1, runtime: 'wsl', distro, uid, home }`，
home 为 canonicalHome；Host 旧格式不要求 scope。

Backend 的 read/write 末尾增加可选 operation；Service 五个公开操作在末尾接受相同可选
operation。无参数调用用 task 2 工具创建自己的 budget，RPC 稍后传入共享 budget。

- [x] **Step 1: 写失败测试。** async store read/write 受 Promise gate 控制，验证 service
  等待保存成功才返回；写失败不发布成功状态。scope 不匹配或损坏密文拒绝并保留文件；
  4 MiB 超限拒绝；Host 旧格式可读。队列等待耗尽 15 秒时 backend.write 不调用。
- [x] **Step 2: 验证失败。** `pnpm test src/main/antigravity/native-account-store.test.ts
  src/main/antigravity/native-account-service.test.ts src/main/antigravity/native-account-launch.test.ts`。
  预期 Promise 被当作 vault 或未等待写入的新断言失败。
- [x] **Step 3: 实现等待与保护。** 复用已有 vault 解析/加密，不新增一套 serializer。
  每个 store/backend 调用显式 await 并传 operation，reconcile 保持原生读取后重读 vault。
  WSL 路径使用严格 async publisher；Host store 保持原路径和既有格式。
  更新当前 launch 的 selectedAccountId 读取为 await，保持本任务阶段 WSL 仍未开启。
  过期队列项在实际运行前拒绝，不用 Promise.race 让修改任务继续后台执行。
- [x] **Step 4: 验证通过。** `pnpm test src/main/antigravity` 与 `pnpm tc:node`；原 Host
  身份稳定、同身份刷新、当前/选定账号不可删除和写后回读全部继续通过。
- [x] **Step 5: 提交。** 提交 `refactor(antigravity): await protected account storage`。

## Task 5: 实现 WSL 凭据协议与安全 guest 读写

**Files:** Create `src/main/antigravity/native-wsl-credential-protocol.ts`、
`native-wsl-credential-script.ts`、`native-wsl-credential-backend.ts`，各自对应 `.test.ts`。
Create `native-wsl-credential-script-fixtures.ts` 用于隔离真实 shell 文件测试。
Modify/Test `native-credential-backend.ts`、`native-credential-backend.test.ts`（仅共享现有冲突语义）。

**Interfaces:** Consumes tasks 1、2、4。
Produces `createAntigravityWslCredentialBackend(authority: ResolvedAntigravityWslTarget):
AntigravityCredentialBackend`，`encodeAntigravityWslWrite(contents: string, expected: string | null):
string`，`decodeAntigravityWslReply(output: string, nonce: string): { status: 'missing' } |
{ status: 'present'; contents: string } | { status: 'written'; contents: string }`，
`buildAntigravityWslCredentialCommand(action: 'read' | 'write', authority: ResolvedAntigravityWslTarget,
nonce: string): WslCommand`。

协议输入固定为 `ORCA_AGY_WSL_INPUT_V1\n<missing 或 expected base64>\n<new base64>\n`。
成功输出固定为 `ORCA_AGY_WSL_REPLY_V1 <nonce>\n<missing/present/written>\n<base64 或空行>\n`。
协议完整性、code=0、未超时与未截断共同决定成功；错误 status 不承载凭据。

- [x] **Step 1: 写失败测试。** codec 测试 canonical base64、nonce、精确行数、UTF-8、末尾
  换行、64 KiB 边界和 192 KiB 输入/输出。backend 测试只发送 input 且不把 token 加到
  argv/env/error；系统级 WSL 错误不能变成 null。
  真实隔离 shell fixtures 测试 0600 普通文件、0644/0400/0700 拒绝、错误所有者、
  符号链接/FIFO/超限/坏 JSON、可写父目录、DrvFS、错误旧字节、同身份刷新：

  ```ts
  await expect(backend.write(credential('b'), credential('stale'), operation)).rejects.toThrow('changed during selection')
  expect(await readFile(nativePath, 'utf8')).toBe(credential('a'))
  ```

- [x] **Step 2: 验证失败。** `pnpm test src/main/antigravity/native-wsl-credential-protocol.test.ts
  src/main/antigravity/native-wsl-credential-script.test.ts src/main/antigravity/native-wsl-credential-backend.test.ts`。
  Linux shell fixtures 是脚本证据，不是 WSL 集成证据。
- [x] **Step 3: 实现固定协议与脚本。** 使用系统工具的已验证选项及固定 PATH，缺少工具
  明确拒绝。所有 guest 操作确认当前发行版、UID、HOME 与绑定一致；拒绝不安全路径。
  先拒绝 FIFO/链接等，再打开描述符并验证其元数据，限量读取并比对前后元数据，避免阻塞。
  读取/写入共享 0600 flock，等待上限 2 秒；缺失目录读取不建目录。
  写入使用私密唯一临时目录、严格解码、cmp、同步、复核旧字节、同目录替换、回读。
  原始 JSON 只由现有 codec 验证，shell 不改 JSON。trap 清理正常退出，遗留清理只检查
  本实现精确命名、所有者与私密权限，不提升遗留文件、不无界扫描。
- [x] **Step 4: 验证通过。** 重跑任务测试及 `pnpm test src/main/antigravity/native-credential-codec.test.ts`。
  加入受控外部写入、原地 truncate/刷新、锁占用和同步失败用例；不把局部锁描述为 agy CAS。
  `pnpm tc:node` 与变更门禁通过，逐项检查捕获的 child spec/错误中没有合成 token。
- [x] **Step 5: 提交。** 提交 `feat(antigravity): add WSL native credential backend`。

## Task 6: 目标服务注册表、动作分发与结果核实

**Files:** Modify/Test `src/main/antigravity/native-account-host.ts`、`native-account-host.test.ts`。
Create `native-wsl-account-recovery.test.ts`；Modify `native-wsl-credential-backend.ts`。
Modify `src/shared/antigravity-account-types.ts`、`native-account-launch.ts` 及其现有测试。
Modify `src/main/runtime/rpc/methods/antigravity-accounts.ts` 的动作调用。
Create `src/main/runtime/rpc/methods/antigravity-accounts.test.ts`。

**Interfaces:** Consumes tasks 2、4、5；Produces `AntigravityAccountAction = 'List' | 'AddCurrent' |
'Select' | 'Remove'` 和 `runAntigravityAccountOperation(target: AntigravityAccountTarget,
action: AntigravityAccountAction, accountId?: string): Promise<AntigravityAccountState>`，
以及 `prepareAntigravityAccountTargetForLaunch(target: AntigravityAccountTarget,
operation: AntigravityAccountOperation): Promise<ResolvedAntigravityWslTarget | null>`。
内部 getAntigravityAccountService 异步解析并共享实例，不把 service 暴露给 renderer。
同时在共享类型增加 `expectedAuthorityId?: string` 与可选的
`resolvedTarget: { runtime: 'wsl'; wslDistro: string; authorityId: string }`；任务 7 再接入 schema 和 UI。

- [ ] **Step 1: 写失败测试。** 单次 default 解析后模拟默认发行版改变，后续 guest 调用仍
  明确指定原发行版；列表后 UID/HOME 或默认改变使修改拒绝。Map 中 Ubuntu/ubuntu
  只构建一个 service，构建失败可重试；Host、两个发行版的 vault、选定 id 和队列隔离。
  对后台仍持锁的超时写入：刷新只读、第二次修改被拒绝；锁释放后必须先回读原生和 vault。
- [ ] **Step 2: 验证失败。** `pnpm test src/main/antigravity/native-account-host.test.ts
  src/main/antigravity/native-wsl-account-recovery.test.ts src/main/runtime/rpc/methods/antigravity-accounts.test.ts`。
  预期现有 WSL 拒绝、缺少分发或未定义目标绑定断言失败。
- [ ] **Step 3: 实现分发。** runAntigravityAccountOperation 创建共享 15 秒 operation，解析
  目标、在任何 store/backend 访问前检查修改绑定、复用作用域服务队列并执行现有业务方法。
  WSL 路径按 scopeHash，响应在摘要上附 resolvedTarget；Host 不附新请求必需项。
  更新四个 RPC handler 使用该入口；缺少 accountId 的 Select/Remove 拒绝。
  本阶段直接分发测试覆盖带绑定的 WSL 修改，RPC 测试覆盖 Host 与 WSL List；绑定字段
  穿过 strict RPC schema 的测试在任务 7 完成。当前 Host launch 改为异步分发入口并更新
  mock，保持原来的 WSL skip 直到任务 8，避免 getService 返回类型变化造成编译失败。
  backend 对提交超时或不完整响应标记需核实；后续动作先获取 guest 锁并回读，失败保持
  拒绝，禁止自动 rollback/replay。移除旧的直接同步 getService 调用并更新 mock。
- [ ] **Step 4: 验证通过。** 重跑上述测试及 `pnpm test src/main/antigravity`。
  断言 Add/Select/Remove/Refresh/Prepare 同作用域共享队列，错误刷新不消除原错误或
  发布虚假的 selectedAccountId；`pnpm tc:node` 通过。
- [ ] **Step 5: 提交。** 提交 `feat(antigravity): route account operations by WSL authority`。

## Task 7: RPC 绑定、能力协商与设置页状态

**Files:** Modify `src/shared/antigravity-account-types.ts`、
`src/shared/rpc-contract/antigravity-accounts-params.ts`、`src/shared/protocol-version.ts`、
`src/main/runtime/orca-runtime-get-status.ts`、`src/renderer/src/runtime/runtime-antigravity-accounts-client.ts`、
`src/renderer/src/components/settings/AntigravityAccountsSection.tsx`。
Modify 对应现有 client/component 测试与任务 6 RPC 测试；Create
`src/main/runtime/antigravity-wsl-capability.test.ts`。生成
`src/shared/rpc-contract/rpc-params-catalog.generated.ts`；新增文案沿用项目现有 i18n 机制。

**Interfaces:** Consumes 任务 6 的 target.expectedAuthorityId 与 state.resolvedTarget。
Produces 两字段的 strict schema 接纳与 UI/client 绑定；schema 的 authorityId 限制为
64 位小写十六进制。增加常量
`ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY = 'accounts.antigravity-native-wsl.v1'`。
既有 callAntigravityAccounts(owner, target, action, accountId?) 继续使用，调用方传绑定后的 target。

- [ ] **Step 1: 写失败测试。** schema 接受有绑定的 WSL 请求、拒绝坏绑定；Host 旧请求
  不变。能力只在 Windows 发布；新版客户端缺能力时不调用 RPC、不发送新增字段给旧 Host。
  UI List 状态保存绑定，Add/Select/Remove 带绑定，default target 保留 null。
  先发 A 修改，再 rerender B，最后完成 A：B 的列表/错误/busy 不被覆盖。
- [ ] **Step 2: 验证失败。** `pnpm test src/renderer/src/runtime/runtime-antigravity-accounts-client.test.ts
  src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx
  src/main/runtime/rpc/methods/antigravity-accounts.test.ts src/main/runtime/antigravity-wsl-capability.test.ts`。
- [ ] **Step 3: 实现协议与页面。** 读 STYLEGUIDE 后只复用已有原语。能力在现有宿主发布过滤
  中按平台判断；strict schema 明确接纳可选字段，handler 对 WSL 修改要求绑定。
  owner/target 切换时清空状态并递增请求代次；初始化请求、动作、错误刷新和 finally
  均检查代次。功能错误后刷新只读且继续显示原错误。WSL Refresh usage 保持 disabled。
  新文案用现有 i18n，跟随项目 catalog 生成/校验，不硬编码设计 token。
- [ ] **Step 4: 验证通过。** 重跑任务测试，`pnpm run generate:rpc-params-catalog`、
  `pnpm run verify:rpc-params-catalog`、`pnpm tc:node`、`pnpm tc:web`。
  新客户端/旧宿主、新宿主/旧客户端、非 Windows、断连四组均有断言；不新增流操作码。
  运行变更代码门禁；若新增目录文案则执行现有 localization 验证。
- [ ] **Step 5: 提交。** 提交 `feat(antigravity): bind WSL account actions to resolved targets`。

## Task 8: 将启动检查接入实际 WSL spawn

**Files:** Modify/Test `src/main/antigravity/native-account-launch.ts`、`native-account-launch.test.ts`。
Modify `src/main/ipc/pty/ipc/spawn-env.ts`、`src/main/ipc/pty/runtime/spawn-options.ts`、
`src/main/ipc/pty/provider/local-configure.ts`。
Create `src/main/ipc/pty/antigravity-account-spawn-target.test.ts`；Modify
`src/main/ipc/pty-daemon-spawn-wsl-runtime.test.ts` 的相关断言。

**Interfaces:** Consumes task 6 launch-target helper。prepareAntigravityAccountForLaunch 的
现有 args 增加 `wslDistro?: string | null`，返回
`Promise<{ wslDistro: string; authorityId: string } | void>`。Host/无需检查可返回 void；
WSL 已准备目标的调用方必须把返回发行版写入真正 spawn 的配置，不只检查一个局部变量。

- [ ] **Step 1: 写失败测试。** 桌面 IPC、runtime/headless、LocalPtyProvider 三个入口均
  传实际 target，返回明确发行版写入最终 terminalWindowsWslDistro/相应 spawn context。
  无保险库不访问 guest；外部换账号或文件缺失拒绝；同 subject/authMethod token 刷新
  更新快照并允许；Windows HOME 不当作 guest HOME；用户/HOME/WSLENV 覆盖无法证明时拒绝。
- [ ] **Step 2: 验证失败。** `pnpm test src/main/antigravity/native-account-launch.test.ts
  src/main/ipc/pty/antigravity-account-spawn-target.test.ts src/main/ipc/pty-daemon-spawn-wsl-runtime.test.ts`。
  预期原代码仍跳过 WSL 或调用方不传发行版。
- [ ] **Step 3: 实现接线。** 保留非 antigravity 与客户端 SSH skip；实际拥有方执行检查。
  复用现有目标解析和 env 删除规则，校验真正 guest 的 UID/HOME、shell/命令可能改变
  authority 的覆盖。只对相关作用域选择执行准备，不把其他 distro vault 套到当前启动。
  在所有低层入口固定已经检查过的发行版，保持既有 daemon 与非 daemon 启动政策。
- [ ] **Step 4: 验证通过。** 重跑任务测试并测试文件夹工作区/worktree、完整 env/envToDelete
  与 SSH 拥有方失败；确认 backend.write 在准备阶段从未自动调用。
  `pnpm tc:node`、`pnpm tc:cli` 与变更门禁通过。
- [ ] **Step 5: 提交。** 提交 `feat(antigravity): verify selected accounts before WSL launches`。

## Task 9: 真实 WSL 证据、全量验收与 PR 准备

**Files:** Create `src/main/antigravity/native-wsl-accounts.wsl.test.ts`、
`native-wsl-accounts-fixtures.ts`、`native-wsl-accounts-isolation.test.ts`。
Modify `docs/reference/antigravity-native-accounts.md` 与此计划。UI 视觉证据存于任务临时目录，
不把账户标识符、token、截图附件或真实凭据提交 Git。

**Interfaces:** WSL 测试只在 `process.platform === 'win32'`、
`ORCA_REAL_ANTIGRAVITY_WSL_ACCOUNTS_TEST=1`、`ORCA_WSL_TEST_DISTRO` 非空且用户准备了
隔离目标时运行。真实测试默认跳过；skip 不计为已通过验证。合成脚本测试在普通 CI 运行。
跨发行版实测还要求 `ORCA_WSL_SECOND_TEST_DISTRO` 指向第二个明确的隔离目标；未配置
就单独 skip 并记录跨发行版证据缺口，不能在现有用户发行版临时修改账号。

- [ ] **Step 1: 创建隔离验收测试。** fixtures 为明确测试目标、临时 HOME 和临时 userData
  构建合成账号；失败/cleanup 也验证正常 HOME/Host 凭据未改。任何会修改真实目标的
  测试要求显式隔离设置，没有设置就 skip，不修改 ~/.profile、真实凭据或默认发行版。
  before/after 的无泄漏断言用文件摘要比较，不打印 token 或账户标识符。
- [ ] **Step 2: 在 Windows 执行。** 先核实已有设置确实指向专用测试环境，PowerShell：

  ```powershell
  $env:ORCA_BACKGROUND_LAUNCH = '1'
  $env:ORCA_REAL_ANTIGRAVITY_WSL_ACCOUNTS_TEST = '1'
  pnpm test src/main/antigravity/native-wsl-accounts-isolation.test.ts src/main/antigravity/native-wsl-accounts.wsl.test.ts src/shared/secure-path-windows-acl.win32.test.ts
  ```

  两个隔离发行版验证全流程、0600、锁竞争、中断、默认目标/UID/HOME 变化、不存在目标
  与 native Windows ACL。记录 Windows、WSL、distro、agy 版本及每项结果。
- [ ] **Step 3: 验证真实 agy 与 UI。** 在专用用户/发行版上按支持的登录方式验证 CLI 读取
  对应文件，选中身份与启动身份一致。测试前先证明受支持的隔离 HOME 行为，不能编造
  agy 参数或改开发者账号。定位项目要求的 electron skill；按其流程重建修改的启动
  包装器，后台启动，通过隐藏 renderer CDP 获取前后证据；不激活窗口。环境或技能缺失
  时保持验收未勾选，报告准确缺口，不用模拟测试或 computer-use 替代。
- [ ] **Step 4: 完成门禁与文档。** `pnpm tc`、`pnpm test src/main/antigravity src/main/wsl
  src/shared/secure-file-publication.test.ts src/shared/secure-file.test.ts
  src/renderer/src/runtime/runtime-antigravity-accounts-client.test.ts
  src/renderer/src/components/settings/AntigravityAccountsSection.test.tsx`，加任务 8 的启动测试。
  变更文件执行项目 formatter；`pnpm run check:code-quality:changed`、RPC/localization
  校验、相关构建与 CI 要求通过。完整 WSL runner 的旧 .wsl.test 会改 profile，只可在
  明确隔离环境启用其原有 flag，不在用户发行版打开。
  更新参考文档的 WSL 支持、严格权限、工具要求、目标绑定、并发和持久性限制。
- [ ] **Step 5: 提交验收与准备 PR。** 提交 `test(antigravity): verify WSL native account lifecycle`。
  自查完整 diff，按 `.github/pull_request_template.md` 写具体体验前后、机制、取舍、平台
  验证、关联实际 issue 与视觉证据；不把 skipped 项目写成通过。未完成的真实验证必须
  明示，不能宣称达到全部验收。推送/创建 stablyai/orca PR 时只操作本 feature 分支，
  不合并上游或强推；PR 创建属于后续实施范围，本次规划提交不发布。

## 覆盖与完成判据

| 设计章节 | 对应任务与完成证据 |
| --- | --- |
| 1–3：目标、复用、职责 | 1–6 的精确模块与共享业务服务；Host 回归 |
| 4：目标隔离与绑定 | 2、4、6、7 的默认/UID/HOME/别名测试与 UI 代次测试 |
| 5：执行与协议 | 1、5 的 stdin、预算、nonce、截断、精确字节、无泄漏断言 |
| 6：文件与提交 | 3、5 的真实临时文件测试；9 的 WSL/ACL 证据 |
| 7：保护与失败 | 3、4、6 的取消、队列、scope、加密拒绝、锁恢复测试 |
| 8：启动 | 8 的三个入口和最终 spawn 配置；9 的真实 CLI 身份证明 |
| 9：兼容与 UI | 7 的四组版本/平台组合和旧 schema/Host 请求断言 |
| 10：17 项验收 | 1–9 测试加真实环境与质量报告；逐项回填设计清单 |
| 11–12：取舍与限制 | 9 的更新参考文档和 PR；保留同名重装、外部竞争等限制 |

本次产物是设计和实施计划进入 Git；产品功能、代码测试、真实 Windows/WSL/UI 验收
均未完成。估计实现 5–8 工作日，取决于隔离 Windows/WSL 与真实 agy 测试环境可用性。

## 执行交接

推荐直接在当前会话按编号执行（superpowers:executing-plans），因为目标、操作预算、
store、backend 和启动接口紧密相连。用户也可以选择 subagent-driven-development，
逐任务实现和独立评审，成本更高。选择执行方式前不启动子代理或产品实施。

用户下一步审阅本计划并选择执行方式。开始实施后每次更新报告一个当前任务、已通过
验证和下一个动作；每任务一个可审查提交，最终对整个 feature 差异再作一次审查。
