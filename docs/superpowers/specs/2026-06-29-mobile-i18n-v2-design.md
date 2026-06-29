# Mobile i18n v2 Design (Chinese / 中文汉化重设计)

**Date**: 2026-06-29
**Status**: Draft — awaiting user review
**Owner**: 汉化支持 branch (v2)
**Target**: Orca Mobile App (`mobile/`) — React Native + Expo SDK 55
**Replaces**: `docs/superpowers/specs/2026-06-28-mobile-i18n-design.md` (v1, 已被 CodeRabbit 否决)

## 背景

v1 设计在 PR #6627 被 CodeRabbit 抓出两个根本缺陷：

1. **`<T>` 组件不带 `i18nKey` 时是个空壳**。`T.tsx` 第 14 行 `i18nKey?: string` 是可选的，v1 迁移的 944 个 `<T>` 标签里只有 332 个传了 `i18nKey`，其余 612 个直接渲染 `children` 字符串 —— 等于没翻译。
2. **共享的桌面 `zh.json` 没有 `mobile.*` 键空间**。桌面端 9,708 个键全是 `settings.*` / `menu.*` / `auto.*` 命名空间，0 个 mobile 相关。共享 ≠ 有东西可共享。

PR #6627 已关闭。`ppw-stack/汉化支持` 分支保留作历史，v2 将开新分支 `ppw-stack/i18n-v2`（基于 `origin/main` 最新代码）。

## 决策摘要（已与用户确认）

| 维度 | 决定 |
|---|---|
| **API 形态** | 桌面同款 `translate(key, fallback, options?)` 函数（替代 v1 的 `<T>` 组件） |
| **翻译键空间** | 桌面 `src/renderer/src/i18n/locales/{en,zh}.json` 加 `mobile.*` 顶层块（共享而非独立） |
| **v1 代码复用** | `init.ts` / `I18nProvider.tsx` / `loadUiLanguage` / `saveUiLanguage` / `init.test.ts` / `preferences.test.ts` 直接沿用 |
| **语言范围** | system / en / zh 三选项（与桌面 6 选项不同；v1 决策） |
| **命名约定** | 语义键（`mobile.<feature>.<sub>.<field>`）；auto.* 内容寻址仅用于一次性 |
| **翻译生成** | 全部人工手写（PR1 ~30 键 / PR2 ~470 键）；不引入机器翻译 bootstrap |
| **PR 拆分** | PR1 = 基建 + Settings + Pair；PR2 = 全量迁移 + 扩展 coverage 到 mobile |
| **测试策略** | i18n 行为测试（纯函数，无需 RN 组件测试基建）+ 手动 smoke |
| **覆盖度闸门** | PR1 仅 `verify:localization-catalog`；PR2 扩展 `verify:localization-coverage` 扫描 `mobile/` |

## 1. 架构

```
┌────────────────────────────────────────────────────────────┐
│ 启动：mobile/app/_layout.tsx                                │
│   useEffect:                                                │
│     loadUiLanguage()   ─→ AsyncStorage('orca:uiLanguage')   │
│     initI18n(lang)     ─→ i18n.changeLanguage(resolved)    │
│     setReady(true)                                           │
│   <I18nProvider i18n={getI18n()}>                           │
│     <Stack />                                               │
│   </I18nProvider>                                           │
│                                                             │
│ 运行时：                                                    │
│   const { t } = useTranslate()                              │
│   <Text>{t('mobile.settings.title', 'Settings')}</Text>     │
│                                                             │
│ 切换：mobile/app/language-settings.tsx                      │
│   onPick(zh):                                               │
│     setLang(zh)                  // 立即更新 UI              │
│     void saveUiLanguage(zh)      // best-effort 持久化       │
│     await i18n.changeLanguage('zh')                         │
│       └→ 所有 useTranslate 组件重渲染                         │
└────────────────────────────────────────────────────────────┘
```

**关键设计决策**：

1. `translate(key, fallback, options?)` **与 `src/renderer/src/i18n/i18n.ts:43` 签名完全一致**，便于将来跨端共享代码
2. v1 的 `init.ts` / `I18nProvider.tsx` / `loadUiLanguage` / `saveUiLanguage` **直接复用**（已通过 v1 review，无 bug）
3. `translate()` 是**同步函数**（内部调用 `getI18n().t()`），可用于渲染 / 事件处理 / 非组件代码

## 2. 翻译键策略

**位置**：`src/renderer/src/i18n/locales/{en,zh}.json` 顶层加 `mobile.*` 块，与现有 `settings.*` / `menu.*` / `auto.*` 平级。

**命名约定**：

| 类型 | 命名 | 例子 | 何时用 |
|---|---|---|---|
| 语义键 | `mobile.<feature>.<sub>.<field>` | `mobile.settings.title: 设置` | 稳定、跨屏复用 |
| 内容寻址 | `auto.mobile.<file-without-ext>.<8-char-hash>` | `auto.mobile.app.settings.ts.abc12345: Settings` | 一次性、局部 |

**v2 默认走语义键**。理由：移动端 80% 字符串是按钮 / 标题 / 状态词，跨屏复用率高（`Cancel` 在 5 个屏出现），语义键查找 / 维护 / review 友好。

**en.json 与 zh.json 同步规则**：
- 改 zh.json 必须同步 en.json
- 复用桌面 `config/scripts/sync:localization-catalog.mjs --fix`：自动加键 / 删键 / 同步占位符
- 桌面 lint 已包含 `verify:localization-catalog`，**自动强制 en/zh 100% 键对齐**

**PR1 mobile.* 块初始内容**（~30 键，仅覆盖 Settings + Language picker + Pair）：

```jsonc
{
  "mobile": {
    "settings": {
      "title": "设置", "language": "语言", "terminal": "终端",
      "browser": "浏览器", "voice": "语音", "notifications": "通知",
      "troubleshooting": "故障排查", "about": "关于",
      "support": "技术支持", "privacy": "隐私政策"
    },
    "language": {
      "title": "语言", "system": "跟随系统",
      "english": "English", "chinese": "中文（简体）"
    },
    "pair": {
      "title": "配对 Orca 桌面",
      "scanHint": "将摄像头对准桌面端显示的二维码",
      "manualEntry": "手动输入配对码",
      "codePlaceholder": "6 位配对码",
      "connect": "连接", "cancel": "取消",
      "openSettings": "打开 Orca 桌面设置 → 远程访问"
    },
    "common": {
      "cancel": "取消", "save": "保存", "delete": "删除",
      "retry": "重试", "open": "打开", "close": "关闭",
      "loading": "加载中…"
    }
  }
}
```

PR2 再补 ~470 键覆盖剩余所有屏与组件。

## 3. 模块结构 + 关键 API

### `mobile/src/i18n/translate.ts`（核心 API）

```ts
// Why: mirror src/renderer/src/i18n/i18n.ts:43 so renderer and mobile
// share the same call shape.
import { getI18n } from './init'
import type { TOptions } from 'i18next'

export function translate(
  key: string,
  fallback: string,
  options?: TOptions
): string {
  return getI18n().t(key, { defaultValue: fallback, ...options })
}
```

### `mobile/src/i18n/useTranslate.ts`（hook 版本）

```ts
// Why: lets components subscribe to language changes and use the same
// t() in event handlers without a second call site.
import { useTranslation } from 'react-i18next'
import type { TOptions } from 'i18next'
import type { MobileResolvedLanguage } from './init'

export function useTranslate() {
  const { t, i18n } = useTranslation()
  return {
    t: (key: string, fallback: string, options?: TOptions) =>
      t(key, { defaultValue: fallback, ...options }),
    resolvedLanguage: i18n.language as MobileResolvedLanguage
  }
}
```

### 调用方式

```tsx
// ① 组件渲染
const { t } = useTranslate()
return <Text>{t('mobile.settings.title', 'Settings')}</Text>

// ② 一次性组件
import { translate as t } from '../src/i18n/translate'
return <Text>{t('mobile.common.cancel', 'Cancel')}</Text>

// ③ 非组件代码
import { translate as t } from '../src/i18n/translate'
toast.error(t('mobile.pair.connectionFailed', 'Connection failed'))

// ④ 插值
const { t } = useTranslate()
t('mobile.pair.codeLabel', 'Code: {{code}}', { code: '123' })
```

### 文件树

```
mobile/src/i18n/
├── init.ts                       # 沿用 v1（无改动）
├── translate.ts                  # 新增（替代 T.tsx）
├── useTranslate.ts               # 新增（替代 useT.ts）
├── I18nProvider.tsx              # 沿用 v1（无改动）
├── __tests__/
│   ├── init.test.ts              # 沿用 v1（9 测）
│   ├── translate.test.ts         # 新增（4 测）
│   └── useTranslate.test.ts      # 新增（3 测）
└── README.md                     # 更新（描述新 API）
```

**删除 v1 残留**：`mobile/src/i18n/T.tsx` / `useT.ts` 及其测试。

## 4. 设置 UI

### 设置入口（mobile/app/settings.tsx 新增一行）

```tsx
const { t } = useTranslate()
...
<Pressable onPress={() => router.push('/language-settings')}>
  <Languages size={16} color={colors.textSecondary} />
  <Text style={styles.rowLabel}>{t('mobile.settings.language', 'Language')}</Text>
  <ChevronRight size={16} color={colors.textMuted} />
</Pressable>
```

行标签随语言切换：英文时显示 "Language"，中文时显示 "语言"。

### 语言选择器（mobile/app/language-settings.tsx）

```tsx
// Why: language pickers must NOT translate their own labels — the user
// needs to see the language name in its native script to recognize it.
const { t } = useTranslate()
const CHOICES: ReadonlyArray<{ value: MobileUiLanguage; label: string }> = [
  { value: 'system', label: 'Follow System' },
  { value: 'en',     label: 'English' },
  { value: 'zh',     label: '中文（简体）' }
]

return (
  <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
    <View style={styles.topRow}>
      <Pressable onPress={() => router.back()}>
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>
      <Text style={styles.heading}>
        {t('mobile.language.title', 'Language')}
      </Text>
    </View>
    {CHOICES.map((choice, i) => (
      <View key={choice.value}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => void onPick(choice.value)}
        >
          <Globe size={16} color={colors.textSecondary} />
          <Text style={styles.rowLabel}>{choice.label}</Text>
          {lang === choice.value && <Check size={16} color={colors.textPrimary} />}
        </Pressable>
        {i < CHOICES.length - 1 && <View style={styles.separator} />}
      </View>
    ))}
  </View>
)
```

### 关键 UX 决策

| 决策 | 理由 |
|---|---|
| 三个选项标签**硬编码不翻译** | 用户必须看到原生语言名才能认出"中文（简体）"是中文 |
| 选完**立即切换** | 视觉反馈即时；不需重启 App；initI18n 已在启动时跑过 |
| `saveUiLanguage` **不 await** | 写失败仅 warn，阻塞 UI 反而体验差 |
| **独立全屏**而非 inline dropdown | 移动端屏幕宽度不够；iOS/Android 用户对 drill-down 更熟 |
| **不显示"当前语言"徽章** | 已选行有 Check 图标足够 |

## 5. PR1 / PR2 拆分

### PR1：基建 + Settings + Pair（8-12 文件 / ~30 mobile.* 键）

| # | Commit | 改动 | 行数 |
|---|---|---|---|
| 1 | `feat(mobile): add translate() and useTranslate() helpers` | `translate.ts` + `useTranslate.ts` + 测试 | ~80 |
| 2 | `feat(i18n): add mobile.* block to en.json / zh.json` | 30 键 × 2 locale | ~120 |
| 3 | `docs(mobile): update i18n README for translate() API` | 替换 v1 文档 | ~40 |
| 4 | `feat(mobile): add Language entry in settings screen` | `settings.tsx` + `language-settings.tsx` | ~120 |
| 5 | `refactor(mobile): migrate Settings + Pair screens to translate()` | `settings.tsx` / `pair.tsx` / `pair-scan.tsx` | ~50 |
| 6 | `chore(mobile): delete obsolete T.tsx + useT.ts` | 清理 v1 残留 | -60 |

**PR1 验证**：
- [ ] `pnpm test` 全部通过（新增 7 测试：4 translate + 3 useTranslate）
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm run verify:localization-catalog` 通过
- [ ] 手动 smoke：切到中文 → Settings 标题变"设置"、Pair 标题变"配对 Orca 桌面"

**PR1 不做**：业务屏、大部分组件、`verify:localization-coverage` 扩展到 mobile。

### PR2：全量迁移（50+ 文件 / ~470 mobile.* 键）

| # | Commit | 改动 | 行数 |
|---|---|---|---|
| 1 | `feat(i18n): add full mobile.* block to en.json` | 一次性加 ~470 键 | ~1200 |
| 2 | `chore(i18n): bootstrap zh.json from en.json` | zh 全部填英文占位 | ~600 |
| 3-15 | `refactor(mobile): migrate <screen> to translate()` | 每屏一 commit | ~50-150 each |
| 16-25 | `refactor(mobile): migrate <component> to translate()` | 每组件一 commit | ~30-100 each |
| 26 | `chore(i18n): translate mobile.* to Chinese (manual review)` | 人工翻译 zh.json | ~600 |
| 27 | `feat(mobile): extend verify:localization-coverage to scan mobile/` | 扩展 lint | ~50 |

**PR2 验证**：
- [ ] 全 mobile 屏切到中文后无英文残留（除故意保留）
- [ ] 47 upstream 新增组件（MobileTerminalInputActions / MobileTerminalLiveInputStatus / MobileCommitFailurePanel 等）有 i18n 覆盖
- [ ] `pnpm run verify:localization-coverage` 通过（mobile/ 也在扫描范围）

### metro.config.js 兼容性

- 上游新 metro.config.js（commit `c7b728da` 之后）只 watch `src/shared/`
- v1 改成 watch `..`（整个 workspace root）是为了跨包引用 `src/renderer/src/i18n/locales/{en,zh}.json`
- **v2 PR1 必须保留 v1 的全部 metro.config.js 改动**（watchFolders + nodeModulesPaths + disableHierarchicalLookup），并向 desktop maintainer 说明：mobile 需要 watch 整个根目录才能 import 桌面翻译键
- 如需最小化分歧，可只保留 `watchFolders: [workspaceRoot, sharedRoot]`，删除 `nodeModulesPaths` 和 `disableHierarchicalLookup`（zh.json 是 JSON 文件，不需解析 desktop node_modules），但需 v2 PR1 验证 Metro 能正确解析

## 6. 覆盖度闸门 + 测试

### A. 翻译键覆盖率（PR1 → PR2 渐进）

| 阶段 | 工具 | 检查 | 强制？ |
|---|---|---|---|
| **PR1** | `verify:localization-catalog`（桌面 lint 已有） | en.json / zh.json 100% 键对齐 + `{{var}}` 占位符一致 | ✅ 自动跑 |
| **PR1** | 人工 review | 30 键中文翻译质量 | 👀 PR author |
| **PR2** | `verify:localization-coverage` 扩展到 mobile/ | 硬英文串必须 (a) 已翻译 或 (b) 显式 allowlist | ✅ 集成进 lint |
| **PR2** | `sync:localization-catalog --fix` | 增键 / 删键 / 修占位符一键同步 | 🔧 工具 |

### B. 测试策略

| 测试类型 | 范围 | PR1 数量 | 工具 | 依赖 RN？ |
|---|---|---|---|---|
| i18n 行为 | translate() / useTranslate() / init | 16（4 + 3 + 9 v1 已有） | vitest | ❌ |
| 存储 | loadUiLanguage / saveUiLanguage | 4（v1 已有） | vitest | ❌ |
| 组件渲染 | translate() 实际被调用 | 0 | — | ❌ **不测** |
| 端到端 smoke | 切换语言后文案正确 | 0（手动） | Expo dev client | — |

**为什么不测组件**：translate() 是纯函数；调用方是 `<Text>{t(...)}</Text>` —— 这是 JSX 表达式替换，无逻辑可测。

**为什么不补 RN 组件测试基建**：v1 已论证需单独基建 PR（@testing-library/react-native + react-test-renderer + vitest env 切换 + 修 CJS Flow 解析），工作量等于 v2 本身。**v2 不开这个口**。

### C. CodeRabbit 标准（避免重蹈 v1 覆辙）

v1 失败的三项 pre-merge check，v2 必须全部 ✅：

| 项 | v1 失败原因 | v2 做法 |
|---|---|---|
| **Docstring coverage ≥ 80%** | 4.17% | 新文件每个函数一行 "Why:"；测试用 `describe` / `it` 描述当 doc |
| **PR 描述完整** | 缺 Screenshots / AI Review / Security / Notes 段 | 按桌面模板写齐四段 |
| **PR 标题规范** | "Ppw stack/汉化支持"（分支名兜底） | `feat(mobile): Chinese (zh) localization via translate() function` |

### D. v1 CodeRabbit 评论的处理

| 类别 | 数量 | v2 处理 |
|---|---|---|
| `<T>` 无 i18nKey = 空壳 | 11 | ✅ 根本解决（改用 `translate(key, fallback)` 函数，必填两参） |
| i18n init race condition | 1 | ✅ v1 commit `b545197a` 已修（try/catch + idempotent singleton） |
| 测试单例未重置 | 1 | ✅ v1 `init.test.ts` 已用 `mockReset()` |
| react-dom 版本对齐 | 1 | ✅ v1 末尾 review 修过（commit `c7b728da`） |
| `<T>` 测试基建缺 | 1 | ✅ v2 不测组件，问题消失 |
| language-settings headerShown | 1 | ✅ v2 沿用 v1 设计 |

**所有 v1 review 批评 → v2 设计中解决**（除"加 RN 测试基建"超出 v2 范围，主动声明不开这个口）。

## 7. 错误处理 + 性能 + 限制

### A. 错误处理矩阵

| 场景 | v2 行为 | 用户感知 |
|---|---|---|
| AsyncStorage 读失败 | `loadUiLanguage` try/catch → `'system'` | 启动正常，跟随系统语言 |
| AsyncStorage 写失败 | `saveUiLanguage` try/catch + warn（不抛） | 语言立即切换，下次启动重置 |
| 翻译键缺失 | i18next `returnEmptyString: false` + `defaultValue: fallback` → 英文 | 显示英文（不空白） |
| i18next 资源加载失败 | `initI18n` 抛错 → `_layout.tsx` 外层 try/catch → 降级 `'en'` | 应用仍启动，UI 全英文 |
| Metro watchFolder 配错 | 启动期 bundle 失败 | 开发者立即看到错误 |
| `expo-localization.getLocales` 抛错 | `resolveSystemLanguage` try/catch → `'en'` | system 模式变英文 |
| `i18n.changeLanguage` 抛错 | `void onPick(...)` 包装；UI 状态已更新 | 选中标记已变，不持久化 |
| zh.json 与 en.json 键不对齐 | 桌面 lint `verify:localization-catalog` 失败 | CI 红灯 |

**关键不变量**：永远不空白 / 永远不崩 / 永远不阻塞 UI。

### B. 性能影响

| 维度 | 量化 |
|---|---|
| `translate()` 单次调用 | ~0.01ms |
| 全屏重渲染（切语言 ~30 字符串） | < 1ms |
| en.json + zh.json bundle 体积 | v2 PR1: +2KB；PR2: +30KB（gzip 后增量可忽略） |
| Metro 启动 | +0（mobile.* 块只是 JSON 内容） |
| 内存 | < 1MB |
| AsyncStorage 读写 | 启动 1 次 read < 5ms；切换 1 次 write fire-and-forget |

**性能预算**：i18n 整体开销在 60fps 渲染预算（16ms）的 1% 以内。

### C. 不在范围内（v2 显式 YAGNI）

| 项 | 原因 | 何时考虑 |
|---|---|---|
| 韩文 / 日文 / 西文 UI 切换 | v2 决策：mobile 仅 system/en/zh | v3 |
| RN 组件单测基建 | 多日工作量；与 i18n 正交 | 单独基建 PR |
| 复数规则 | 中文不需要 | 永远 |
| RTL 布局 | 项目不支持阿语 | 永远 |
| 运行时 locale 变化监听 | 重启 App 即可 | 永远 |
| 与桌面 RPC 同步 uiLanguage | 走独立设置；引入协议变更不值 | v3+ if user demand |
| TypeScript 翻译键类型自动生成 | 桌面也没做 | v3 |
| 翻译覆盖率审计脚本（mobile/） | v2 PR2 末尾扩展；v1 不做 | v2 PR2 |
| CLI 工具 i18n | 桌面 CLI 也不 i18n | 永远 |
| 机器翻译 bootstrap zh | 保持翻译质量 | 永远 |
| lazy load 翻译资源 | 500 键 < 1MB，无需分块 | 永远 |

## 风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| 上游 main 改 desktop i18n API（`translate` 签名变化） | 低 | v2 与上游同步；任何变化都要跟着改 mobile |
| 上游改 mobile 屏的内容（加新英文硬串） | 中 | PR2 之后每次上游改动都可能引入未翻译串；扩展 coverage 后 CI 拦截 |
| mobile.* 键空间命名冲突（与 desktop `auto.*` hash 撞名） | 极低 | `mobile.*` 顶层隔离；hash 算法只看 fallback 不看 namespace |
| 47 upstream 新增组件没在 PR2 范围统计内 | 中 | PR2 任务清单重扫 mobile/src/components/ |

## 未来扩展（v3 候选）

- 暴露 ko/ja/es 切换（与桌面 6 选项对齐）
- 翻译键 TypeScript 类型自动生成
- 与桌面 RPC 同步 uiLanguage
- RN 组件测试基建（独立 PR）
- 翻译覆盖率审计脚本（mobile/）—— v2 PR2 末尾做
- 机器翻译 bootstrap zh —— v3+ 视质量决定
- 运行时 locale 变化监听

## 验收清单（v2 PR1）

- [ ] `pnpm test` 全部通过（含新增 7 测试）
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm run verify:localization-catalog` 通过
- [ ] `pnpm lint` 通过
- [ ] 手动 smoke：
  - 启动 → Settings 看到 "Language" 行
  - 点 Language → 三个选项（Follow System / English / 中文（简体））
  - 选"中文（简体）" → UI 立即切换，无需重启
  - 重启 App → 中文选择被保留
  - 选"Follow System" → 跟随系统语言
- [ ] PR 标题：`feat(mobile): Chinese (zh) localization via translate() function`
- [ ] PR 描述含 Spec / Plan 链接 + CodeRabbit 改进点
- [ ] v1 残留（`T.tsx` / `useT.ts`）已删除
