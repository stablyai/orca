# Checks

- **Gate**: `pnpm check:changed` runs format, lint, typecheck, the tests that import your changes, and the ratchets your paths select, and prints only failures. Run it once when you are done editing (and again after a rebase or fix), then push. A pass is cached, so don't rerun it "to be sure", and don't also run `pnpm tc`, `pnpm lint`, or the full suite. Never `--no-verify`.
- **While iterating**: run only what you touched: `pnpm test <file.test.ts> --maxWorkers=2`, `pnpm tc:node|tc:web|tc:cli`, `pnpm exec oxlint <files>`, `pnpm exec oxfmt --write <files>`. Transitive tests and the full suite are CI's job ([details](.github/CONTRIBUTING.md#targeting-local-tests)).
- Run checks in the foreground with `timeout 900`. Don't background them and poll with `sleep`.
- Stacked PRs: `ORCA_CODE_QUALITY_BASE=<ref>` or `--base=<ref>`; `--base=HEAD` covers only uncommitted edits.
- CI: `gh pr checks --watch` or `gh run watch <id> --compact --exit-status` (no polling). Read failures with `gh run view <id> --log-failed`; for long logs, filter with `grep -nE "error|FAIL|✗"` instead of tailing.

# Repo Rules

- Ensure main is always releasable
- Never break the CI. If it's broken, merge fixes.
- **Tests are the exception.** Prove a change by running it (app via CDP screenshot, CLI, script), not by committing a test. Commit one only for logic where a silent regression is costly: parsers/codecs/round-trips, security boundaries (escaping, path traversal, auth, crypto), persistence/migrations/data loss, concurrency or state-machine invariants, cross-platform paths. It must call real code with minimal mocks, hardcode its expectations, and fail if the fix is reverted; prefer one invariant over many examples. Never test UI behavior ("button does X"), wiring/IPC glue, mock calls, copy, constants, or timing. Critical user flows belong in the golden E2E journeys (`tests/e2e/golden-journeys`), not unit tests. Delete low-value tests you touch instead of updating them. Perf contracts: `*.performance.test.*` only ([rules](./docs/agents-md-refs/test-antipatterns.md#perf-contracts)); more in [anti-patterns](./docs/agents-md-refs/test-antipatterns.md).

# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role.

# zh-Hant 語系維護（本分支）

## 基準與驗證

- **唯一基準**：翻譯/補鍵一律以**官方上游原始英文 `en.json`** 為語意與鍵集基準（桌面 `src/renderer/src/i18n/locales/en.json`、行動 `mobile/src/i18n/locales/en.json`，對照 `origin/main` 最新版本）。`zh.json`/其他語系僅可作術語參考，不可直接覆蓋語意；採用前必須逐鍵確認與英文原文一致。**簡中轉繁不得作為最終正確性依據**（簡體中文可能落後、漏譯或語意偏移）。
- **每次更新前先校對上游**：在 `F:\DevProjects\OrcaADE\zh-maintenance` 執行 `npm run rebase`（或 `npm run refresh`）前，先確認 `origin/main` 已 fetch 且比對最新英文鍵集；缺鍵/待譯以英文鍵為準產生報告，不以簡體中文是否有對應鍵判斷。
- **TM 規則**：`zh-maintenance/tm/*.json` 寫入前必須對照英文 `en.json`；自動轉換/OpenCC 產物不得未經稽核直接寫入 TM。保留既有人工校正。
- **驗證**：`cd F:\DevProjects\OrcaADE\zh-maintenance && node scripts/check.mjs` 必須通過（鍵完整、佔位符/標籤一致、無簡體殘留）；結構通過不等於語意正確，新增/大批變更需抽審英文語意。

## 發佈流程（雙倉庫，務必遵守）

本專案涉及兩個**歷史不相同**的 Git 倉庫，不能混用推送目標：

| 倉庫 | 路徑/Remote | 用途 | 可否直接推送 zh-Hant |
| --- | --- | --- | --- |
| `orca-zh` | `F:\DevProjects\OrcaADE\orca-zh`（`origin=stablyai/orca`, `fork=ainlee/orca`, `zh-hant=ainlee/Orca_zh-Hant`） | 翻譯工作區：對照上游英文、修改/驗證 `zh-Hant.json`、提交翻譯工作 | **不可**直接把 `orca-zh` commit 推到 `zh-hant` remote；歷史無共同祖先且含上游大歷史/partial clone 物件，會被拒絕（non-fast-forward / unpack failed） |
| `Orca_zh-Hant` | `https://github.com/ainlee/Orca_zh-Hant.git` | 發佈倉庫：Orca 社群外掛/語系包，含 `orca-plugin.json`、`locales/zh-Hant.json`、README | **唯一發佈目標** |

**正確作法（固定）：**

1. 在 `orca-zh` 完成翻譯並驗證：`cd F:\DevProjects\OrcaADE\zh-maintenance && npm run check`（必要時 `npm run rebase`）。
2. 用 publish 腳本發佈，**不要**手動 `git push zh-hant ...`：
   ```powershell
   cd F:\DevProjects\OrcaADE\zh-maintenance
   npm run publish:zh-hant:dry   # 可選：先看會建立什麼 commit
   npm run publish:zh-hant       # 推送到 ainlee/Orca_zh-Hant i18n/zh-hant-coverage
   ```
3. `publish.mjs` 會：暫存 clone `Orca_zh-Hant`（`main`）→ 建立/重設 `i18n/zh-hant-coverage` → 只複製桌面、行動、插件 `zh-Hant.json`（`config.publish` 定義）→ commit → push。若遠端同名分支有舊歷史，腳本會以 `--force-with-lease` 更新發佈分支（發佈內容以 zh-maintenance 產出為準）。
4. 推送後到 GitHub 開 PR：`i18n/zh-hant-coverage -> main`，確認後合併。可用 `gh pr create` / `gh pr merge`。
5. **社群市場發版（僅在要讓 Orca 市場/`orca plugin update` 偵測新版本時）**：僅合併 `main` **不會**更新社群目錄。需另外在 `Orca_zh-Hant`：
   - 更新 `orca-plugin.json` 的 `version`（`X.Y.Z` 三段版；同一官方版內修補遞增第三段）。
   - commit 後建立 `vX.Y.Z` tag，push `main` + tag。
   - 版本/tag/檢查清單以 [Orca_zh-Hant AGENTS.md](https://github.com/ainlee/Orca_zh-Hant/blob/main/AGENTS.md) 為準；執行前確認。
6. **禁止推送官方 `stablyai/orca`（origin）**；`origin` 僅用於 fetch 上游。外部推送（GitHub push/merge）前需確認。

**不要做：**

- 不要 `git push zh-hant HEAD:i18n/zh-hant-coverage`（歷史不同，會 non-fast-forward）。
- 不要把 `orca-zh` 的上游程式碼/歷史推到 `Orca_zh-Hant`。
- 不要手動複製檔案後忘記同步 `locales/zh-Hant.json`（插件包用）；publish 腳本已包含 `config.publish.pluginLocalePath`。

# Electron UI Validation

- Always run tests and agent-launched apps in the background with `ORCA_BACKGROUND_LAUNCH=1`.
- Never steal monitor focus or reveal test windows: no `show()`, `showInactive()`, `bringToFront()`, `app.focus()`, or OS activation. Use CDP screenshots of hidden renderers.
- Keep native-focus and visible-window tests paused on the user's desktop; run them on an isolated display or CI.
- Rebuild modified launch-policy code before running an app (stale build wrappers are not safe).
- Use the `$electron` skill and Playwright CDP for rendered Orca UI checks. Do not use computer-use for Orca UI validation.
- Rendered UI E2E checks need an explicit, reproducible viewport and state.
- Screenshot presentational components without Electron: `pnpm fixtures:shot <id>` ([fixtures](docs/agents-md-refs/component-fixtures.md)).

# Code Style

## Reuse Before Reimplementing

Before writing new logic at any scale extend or generalize it instead of building a parallel version.

## Avoid Comments

- Only use when code does not describe
- BE CONCISE. 1 LINE if possible (why not how)

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

# First Class Citizens

Every change must consider these areas:

1. Cross-Platform Support (mac/linux/windows)
   - Guard platform-specific behavior at runtime; use platform-aware shortcuts, paths, and existing process wrappers. Before changing platform-specific code, processes, shells, shortcuts, paths, or native modules, read [`docs/agents-md-refs/cross-platform-support.md`](./docs/agents-md-refs/cross-platform-support.md).
2. Remote hosts
   - Features should work locally and on remote hosts
3. Mobile
4. Folder Workspaces
   - Don't assume every workspace is a git worktree.

# Footguns

## Git / GitHub

If changing code around `git`, `gh`, source-control, or review behavior read [`docs/agents-md-refs/git-workflow.md`](./docs/agents-md-refs/git-workflow.md).
