# orca-scryer 同步脚本

这个仓库有两个本地脚本，用来让 `orca-scryer` 分支持续跟上官方 Orca 的高频更新。

- `scripts/orca-scryer-watch.sh`：轻量检查官方 `origin/main` 是否有新提交。
- `scripts/orca-scryer-sync.sh`：发现更新后执行完整同步、rebase、测试和推送。
- `scripts/orca-scryer-package-install.sh`：可选的 Ubuntu AppImage/deb 打包和本机更新步骤。

## 关键分支

- `origin/main`：官方仓库 `stablyai/orca` 的 `main`。
- `fork/main`：你的 fork 仓库 `Nikolatesla-lj/orca` 的 `main`。
- `orca-scryer`：我们正在开发的功能分支。

目标状态：

```text
origin/main = fork/main = 本地 main
orca-scryer = 最新 main + Scryer 集成功能
```

## watch 触发逻辑

`watch` 每次只做一件事：用 `git ls-remote origin refs/heads/main` 查询官方 `main` 当前提交号。

- 第一次运行：只记录当前提交号，不触发同步。
- 官方提交号没变：不做任何重操作。
- 官方提交号变了：调用 `scripts/orca-scryer-sync.sh`。

同步成功后，`watch` 才会把新的官方提交号写入状态文件。同步失败时不会推进状态，下一次检查还会重试。

状态和日志默认放在：

```text
.git/orca-scryer-sync/
.git/orca-scryer-sync/logs/
```

## sync 完整流程

`sync` 执行以下步骤：

1. 拉取官方 `origin/main`。
2. 拉取你的 `fork/main` 和 `fork/orca-scryer`。
3. 检查 `fork/main` 是否只落后官方 `main`，如果你的 fork main 有额外提交就停止。
4. 把 `fork/main` 快进到 `origin/main`。
5. 切到本地 `orca-scryer`。
6. 把本地 `main` 对齐到最新 `origin/main`。
7. 把 `orca-scryer` rebase 到最新 `origin/main`。
8. 跑检查：
   - focused unit tests
   - `pnpm run tc:web`
   - `pnpm run tc:node`
   - `oxlint`
   - `oxfmt --check .`
   - architecture live e2e
9. 全部通过后，用 `git push --force-with-lease fork orca-scryer` 更新远端功能分支。
10. 如果设置 `ORCA_SCRYER_AUTO_PACKAGE=1`，从 rebase 后的功能分支运行 Ubuntu 打包。
11. 如果同时设置 `ORCA_SCRYER_AUTO_INSTALL=1`，把最新 AppImage 安装到本机路径并更新 `orca` 启动 symlink。
12. 最后同步本地状态，让本地 `main`、本地 `orca-scryer` 和 GitHub 远端一致。

如果本地 `orca-scryer` 有未提交改动，脚本会先用 `git stash` 临时保存，完成同步后再恢复。`stash` 可以理解成“先把没提交的改动临时收起来”。

如果 rebase 冲突、测试失败或 stash 恢复失败，脚本不会推送 `orca-scryer`，并会保留日志和失败现场。

## 手动运行

只检查官方 main 是否变化：

```bash
scripts/orca-scryer-watch.sh
```

不等官方变化，直接跑完整同步：

```bash
scripts/orca-scryer-sync.sh
```

测试脚本自身的 watch 触发逻辑：

```bash
bash tests/scripts/orca-scryer-watch.test.sh
```

测试打包/安装脚本自身逻辑：

```bash
bash tests/scripts/orca-scryer-package-install.test.sh
```

测试 cron 安装脚本会写入自动打包/安装环境变量：

```bash
bash tests/scripts/orca-scryer-install-cron.test.sh
```

## 可选：同步后自动打包并更新本机 Orca

默认情况下，`sync` 不会自动替换本机 Orca。要开启它，运行同步或安装 cron 时显式传入：

```bash
ORCA_SCRYER_AUTO_PACKAGE=1 \
ORCA_SCRYER_AUTO_INSTALL=1 \
scripts/orca-scryer-sync.sh
```

默认打包命令是：

```bash
corepack pnpm run build:linux
```

它会使用 Electron Builder 生成 Ubuntu 可运行的 `AppImage` 和 `.deb`。脚本会把本次构建产物复制到：

```text
.git/orca-scryer-sync/releases/
```

默认本机安装方式是 AppImage：

```text
~/.local/share/orca-scryer/orca-linux.AppImage
~/.local/bin/orca -> ~/.local/share/orca-scryer/orca-linux.AppImage
~/.local/bin/orca-app -> ~/Applications/Orca/current.AppDir/orca-ide
~/.local/bin/orca-app-cli -> ~/Applications/Orca/current.AppDir/resources/bin/orca
~/Applications/Orca/current.AppDir -> ~/Applications/Orca/orca-scryer-<commit>.AppDir
```

`orca-app-cli` 是 `/home/ljian/.agents/orca` 搜索和浏览器自动化链路优先使用的命令。它指向 `current.AppDir`，所以每次自动安装后会跟随最新的 orca-scryer 解包版本，不依赖 AppImage/FUSE。

可以用环境变量改路径：

```bash
ORCA_SCRYER_APPIMAGE_INSTALL_PATH="$HOME/Apps/Orca.AppImage" \
ORCA_SCRYER_APPIMAGE_SYMLINK="$HOME/.local/bin/orca" \
ORCA_SCRYER_APPIMAGE_CLI_LAUNCHER="$HOME/.local/bin/orca-app-cli" \
ORCA_SCRYER_AUTO_PACKAGE=1 \
ORCA_SCRYER_AUTO_INSTALL=1 \
scripts/orca-scryer-sync.sh
```

如果要用 `.deb` 安装：

```bash
ORCA_SCRYER_INSTALL_KIND=deb \
ORCA_SCRYER_AUTO_PACKAGE=1 \
ORCA_SCRYER_AUTO_INSTALL=1 \
scripts/orca-scryer-sync.sh
```

`.deb` 安装可能需要 `sudo`。cron 环境里如果不能交互输入密码，建议继续用默认 AppImage。

## 安装每 12 小时自动检查

运行：

```bash
scripts/orca-scryer-install-cron.sh
```

它会向当前用户的 crontab 写入这段任务：

```cron
0 */12 * * * /home/ljian/wspace/orca-scryer/orca/scripts/orca-scryer-watch.sh
```

如果安装 cron 时带上自动打包变量，安装脚本会把这些变量写进 crontab：

```bash
ORCA_SCRYER_AUTO_PACKAGE=1 \
ORCA_SCRYER_AUTO_INSTALL=1 \
scripts/orca-scryer-install-cron.sh
```

查看已安装任务：

```bash
crontab -l
```

查看 cron 日志：

```bash
tail -n 200 .git/orca-scryer-sync/logs/watch-cron.log
```

## 常见失败

### fork main 有额外提交

脚本会停止，因为它不应该覆盖你的 fork main 上独有的提交。

处理方式：先人工确认这些提交是否要保留。

### rebase 冲突

脚本会停止，不推送 `orca-scryer`。

处理方式：进入仓库后运行：

```bash
git status
```

按 Git 提示解决冲突，然后继续或中止 rebase。

### 测试失败

脚本会停止，不推送 `orca-scryer`。

处理方式：打开 `.git/orca-scryer-sync/logs/` 里的最新日志，先修测试失败，再手动运行：

```bash
scripts/orca-scryer-sync.sh
```
