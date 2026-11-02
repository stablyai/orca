# Traditional Chinese (Taiwan) localization

Traditional Chinese uses the built-in locale `zh-Hant`, labeled `繁體中文（台灣）`. Copy follows Taiwan conventions. System detection maps `zh-TW`, `zh-HK`, `zh-MO` and any `zh-Hant*` tag to `zh-Hant`. Bare `zh`, `zh-CN`, `zh-SG` and `zh-Hans*` stay on Simplified `zh`. The renderer and main process load the catalog lazily. Missing keys fall back to English, not Simplified: both i18next instances use `load: 'currentOnly'`.

The catalog lives at `src/renderer/src/i18n/locales/zh-Hant.json` and is maintained by hand like every other built-in catalog. Do not regenerate it from `zh.json`, because character conversion carries over mainland terms (智慧體, 會話, 倉庫). Use `zh.json` only to check meaning.

## Glossary

| English                        | 繁體中文（台灣）                    |
| ------------------------------ | ----------------------------------- |
| agent / AI agent / subagent    | 代理程式 / AI 代理程式 / 子代理程式 |
| worktree / workspace           | 工作樹 / 工作區                     |
| repository                     | 存放庫                              |
| issue / pull request           | 議題 / PR                           |
| commit / branch / merge        | 提交 / 分支 / 合併                  |
| rebase / checkout              | 變基 / 檢出                         |
| session                        | 工作階段                            |
| terminal / tab / pane / window | 終端機 / 分頁 / 窗格 / 視窗         |
| file / folder / directory      | 檔案 / 資料夾 / 目錄                |
| settings / default / profile   | 設定 / 預設 / 設定檔                |
| server / network / host        | 伺服器 / 網路 / 主機                |
| remote / local                 | 遠端 / 本機                         |
| program / software / process   | 程式 / 軟體 / 行程                  |
| code / source control          | 程式碼 / 原始碼控制                 |
| plugin / extension             | 外掛 / 擴充功能                     |
| account / permission           | 帳戶 / 權限                         |
| message / information          | 訊息 / 資訊                         |
| project / data / cache         | 專案 / 資料 / 快取                  |
| create / add / load / save     | 建立 / 新增 / 載入 / 儲存           |
| run / launch / detect / build  | 執行 / 啟動 / 偵測 / 建置           |
| row / column / cell            | 列 / 欄 / 儲存格                    |
| skill / automation / workflow  | 技能 / 自動化 / 工作流程            |
| review / diff / stash          | 審查 / 差異 / 儲藏                  |
| sidebar / browser / preview    | 側邊欄 / 瀏覽器 / 預覽              |
| usage / quota / dictation      | 用量 / 配額 / 聽寫                  |
| shortcut / prompt / context    | 快速鍵 / 提示詞 / 上下文            |
| access token / model tokens    | 權杖 / token                        |
| credential / notification      | 憑證 / 通知                         |
| thread / schedule / emulator   | 討論串 / 排程 / 模擬器              |

## Style

- Quote UI text with 「」, and use 『』 for nested quotes. Do not use “”.
- Put a half-width space between CJK text and Latin letters or digits.
- Keep product, provider, model and CLI names in their original form (Orca, Claude Code, Codex, GitHub, Git, SSH, WSL).
- Keep `{{placeholders}}`, markup, commands, paths and shortcuts exactly as they appear in English.

## Verification

```sh
pnpm run verify:localization-catalogs
pnpm run verify:localization-extraction
pnpm run verify:localization-coverage
```
