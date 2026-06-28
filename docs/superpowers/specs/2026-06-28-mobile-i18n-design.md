# Mobile App i18n Design (Chinese / 中文汉化)

**Date**: 2026-06-28
**Status**: Draft — awaiting user review
**Owner**: 汉化支持 branch (`ppw-stack/汉化支持`)
**Target**: Orca Mobile App (`mobile/`) — React Native + Expo 55

## 背景

桌面端 Orca 已完整支持 5 种语言（含中文），用户可在 Settings → Appearance → Language 切换。
但移动端 (`mobile/`) 完全未接入 i18n：所有用户可见文案均为硬编码英文，且 Settings 屏没有语言切换入口。
本设计为移动端补齐中文（v1）汉化能力，保留扩展到其他语言的路径。

## 决策摘要（已与用户确认）

| 维度 | 决定 |
|---|---|
| 语言范围（v1） | 仅中文（zh） |
| 与桌面端同步 | 独立设置，不同步 |
| i18n 框架 | i18next + react-i18next |
| 翻译源 | 直接引用桌面端 `src/renderer/src/i18n/locales/zh.json`（Metro watchFolders） |
| 屏幕覆盖 | 全部 23 个 `mobile/app/**/*.tsx` 路由文件（含 `_layout.tsx`）+ 主要组件 |
| 持久化 | AsyncStorage，沿用 `mobile/src/storage/preferences.ts` 既有模式 |
| 默认行为 | 首次启动默认 `'system'`，与桌面端语义一致 |
| 组件抽象 | 自研 `<T>` React Native 包装组件（基于 react-i18next） |

## 架构

### 文件布局

```
mobile/
├── package.json                     ← 新增依赖 i18next, react-i18next, expo-localization
├── metro.config.js                  ← 新增 watchFolders: ['..'] 与 nodeModulesPaths
└── src/
    ├── i18n/                        ← 全新目录
    │   ├── init.ts                  ← i18next createInstance() + init({ resources })
    │   ├── I18nProvider.tsx         ← <I18nextProvider> 包裹 app
    │   ├── T.tsx                    ← 自定义 <T> 组件（核心抽象）
    │   ├── useT.ts                  ← 组件外使用的 t() hook
    │   ├── types.ts                 ← i18next module augmentation
    │   ├── T.test.tsx               ← <T> 组件单测
    │   ├── init.test.ts             ← i18n 初始化单测
    │   └── useT.test.ts             ← 非组件 hook 单测
    └── storage/
        └── preferences.ts           ← 追加 loadUiLanguage / saveUiLanguage + UI_LANGUAGE_KEY
```

### Metro 配置变更

`mobile/metro.config.js` 需要允许 Metro 解析包外文件：

```js
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// 1. Watch all files within the monorepo
config.watchFolders = [workspaceRoot]

// 2. Let Metro know where to resolve packages and in what order
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
]

// 3. Force Metro to resolve (sub)dependencies only from the `nodeModulesPaths`
config.resolver.disableHierarchicalLookup = true

module.exports = config
```

**为什么必须改 Metro**：
i18next 资源在 `import zh from '../../../src/renderer/src/i18n/locales/zh.json'` 时，Metro 默认只在 `mobile/` 子树内查找。加上 `watchFolders` 才能跨过 `../` 边界读到桌面端的翻译文件，同时热重载也能跨包工作。

### 翻译资源引用

`mobile/src/i18n/init.ts` 直接 import 桌面端 zh.json，**不复制**：

```ts
import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import * as Localization from 'expo-localization'

import zh from '../../../src/renderer/src/i18n/locales/zh.json'
import en from '../../../src/renderer/src/i18n/locales/en.json'

export type MobileUiLanguage = 'system' | 'en' | 'zh'
export type MobileResolvedLanguage = 'en' | 'zh'

const FALLBACK_LANGUAGE: MobileResolvedLanguage = 'en'

function resolveSystemLanguage(): MobileResolvedLanguage {
  try {
    const locales = Localization.getLocales?.()
    const primary = locales?.[0]?.languageCode
    return primary === 'zh' ? 'zh' : FALLBACK_LANGUAGE
  } catch {
    return FALLBACK_LANGUAGE
  }
}

export function resolveLanguage(lang: MobileUiLanguage): MobileResolvedLanguage {
  if (lang === 'zh') return 'zh'
  if (lang === 'en') return 'en'
  return resolveSystemLanguage()
}

let instance: I18nInstance | null = null

export async function initI18n(language: MobileUiLanguage): Promise<I18nInstance> {
  if (instance) return instance
  const resolved = resolveLanguage(language)
  instance = i18next.createInstance()
  await instance
    .use(initReactI18next)
    .init({
      lng: resolved,
      fallbackLng: FALLBACK_LANGUAGE,
      defaultNS: 'translation',
      interpolation: { escapeValue: false },
      returnEmptyString: false,
      resources: {
        zh: { translation: zh },
        en: { translation: en }
      }
    })
  return instance
}

export function getI18n(): I18nInstance {
  if (!instance) throw new Error('i18n not initialized — call initI18n() first')
  return instance
}
```

**en 资源的目的**：v1 不暴露 "English" 切换项，但保留 en 资源是必须的——
当中文翻译键缺失时 i18next 会回退到 `fallbackLng: 'en'`，避免显示空白键路径（这是与桌面端 `src/main/i18n/main-i18n.ts` 一致的策略）。

## 核心组件：`<T>`

`mobile/src/i18n/T.tsx`：

```tsx
import { useTranslation } from 'react-i18next'
import { Text, type TextProps } from 'react-native'

export type TProps = Omit<TextProps, 'children'> & {
  /** 显式指定翻译键。省略时直接渲染 children */
  i18nKey?: string
  /** fallback 文案；同时作为 i18next 的 defaultValue */
  children: string
  /** 插值参数 */
  values?: Record<string, string | number>
  /** 命名空间，默认 translation */
  ns?: string
}

export function T({ i18nKey, children, values, ns, ...rest }: TProps) {
  const { t } = useTranslation(ns ? [ns] : undefined)
  if (i18nKey) {
    const translated = t(i18nKey, { defaultValue: children, ...values })
    return <Text {...rest}>{translated}</Text>
  }
  return <Text {...rest}>{children}</Text>
}
```

**设计要点**：

1. **`children` 必填为字符串**：TypeScript 编译期保证每次使用 `<T>` 都提供 fallback 原文
2. **`i18nKey` 可选**：简单场景下可直接 `<T>Settings</T>`，不指定键也能编译过
3. **包一层 `<Text>`**：保留原生 `TextProps`（style、numberOfLines 等），改造时几乎不用动外层样式
4. **订阅 languageChanged**：react-i18next 内部已处理，组件自动重渲染

### 用法对照

| 改前 | 改后 |
|---|---|
| `<Text style={styles.title}>Settings</Text>` | `<T style={styles.title}>Settings</T>` |
| `<Text>{`Hello, ${name}!`}</Text>` | `<T values={{ name }}>Hello, {{name}}!</T>` |
| `<Text>{t('settings.title')}</Text>` | `<T i18nKey="settings.title">Settings</T>` |
| `<Text numberOfLines={1}>Long title…</Text>` | `<T numberOfLines={1}>Long title…</T>` |

### 非组件代码的 hook

`mobile/src/i18n/useT.ts`：

```ts
import { useTranslation } from 'react-i18next'

/** 在 React 组件外的纯逻辑模块（如 transport、host-store）使用 */
export function useT() {
  const { t, i18n } = useTranslation()
  return {
    t,
    /** 当前解析后的语言（不含 'system'） */
    resolvedLanguage: i18n.language as 'en' | 'zh'
  }
}
```

对于**组件外的纯字符串**（如 `mobile/src/transport/host-names.ts` 中的错误信息），通过 `import { getI18n } from './init'` 拿同步实例调用 `getI18n().t(key, defaultValue)`。

## 持久化

`mobile/src/storage/preferences.ts` 追加：

```ts
const UI_LANGUAGE_KEY = 'orca:uiLanguage'

export type MobileUiLanguage = 'system' | 'en' | 'zh'
const DEFAULT_UI_LANGUAGE: MobileUiLanguage = 'system'

function normalizeUiLanguage(value: unknown): MobileUiLanguage {
  return value === 'en' || value === 'zh' || value === 'system'
    ? value
    : DEFAULT_UI_LANGUAGE
}

export async function loadUiLanguage(): Promise<MobileUiLanguage> {
  try {
    const raw = await AsyncStorage.getItem(UI_LANGUAGE_KEY)
    if (raw === null) return DEFAULT_UI_LANGUAGE
    return normalizeUiLanguage(raw)
  } catch {
    return DEFAULT_UI_LANGUAGE
  }
}

export async function saveUiLanguage(lang: MobileUiLanguage): Promise<void> {
  try {
    await AsyncStorage.setItem(UI_LANGUAGE_KEY, lang)
  } catch (error) {
    // 语言立即生效；持久化失败仅记录，下次启动会用默认值
    console.warn('[preferences] saveUiLanguage failed', error)
  }
}
```

**与桌面端 `uiLanguage` 不互通**：
- 桌面端类型 `UiLanguage` 在 `src/shared/ui-language.ts`，包含 6 个值（system/en/zh/ko/ja/es）
- 移动端 v1 只暴露 3 个值（system/en/zh）
- **无 RPC 字段同步**，避免引入协议变更；后续如果需要再做

## 设置 UI

### 新增屏幕

`mobile/app/language-settings.tsx`（新建，沿用 `mobile/app/settings.tsx` 的视觉模式）：

```tsx
export default function LanguageSettingsScreen() {
  const [lang, setLang] = useState<MobileUiLanguage>('system')
  const insets = useSafeAreaInsets()

  useEffect(() => {
    void loadUiLanguage().then(setLang)
  }, [])

  const onPick = useCallback(async (next: MobileUiLanguage) => {
    setLang(next)                    // 立即生效
    await saveUiLanguage(next)       // 持久化
    await getI18n().changeLanguage(resolveLanguage(next))
  }, [])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Language</Text>
      </View>

      {LANGUAGE_CHOICES.map((choice) => (
        <Pressable key={choice.value} onPress={() => onPick(choice.value)}>
          <Text>{choice.label}</Text>
          {lang === choice.value && <Check size={16} />}
        </Pressable>
      ))}
    </View>
  )
}
```

### 在 Settings 入口插入

`mobile/app/settings.tsx` 增加一行（与现有 Terminal / Browser / Voice / Notifications 平级）：

```tsx
<Pressable onPress={() => router.push('/language-settings')}>
  <Languages size={16} color={colors.textSecondary} />
  <Text style={styles.rowLabel}>Language</Text>
  <ChevronRight size={16} color={colors.textMuted} />
</Pressable>
```

文案（v1 英中并存，因屏幕内文本本身也将被翻译）：

| i18nKey | 英文 | 中文 |
|---|---|---|
| `settings.title` | Settings | 设置 |
| `settings.language` | Language | 语言 |
| `language.title` | Language | 语言 |
| `language.system` | Follow System | 跟随系统 |
| `language.english` | English | English |
| `language.chinese` | 中文（简体） | 中文（简体） |

## 数据流

### 启动加载（`mobile/app/_layout.tsx`）

```
RootLayout
    │
    ├─ const [ready, setReady] = useState(false)
    │
    ├─ useEffect:
    │     const lang = await loadUiLanguage()
    │     await initI18n(lang)
    │     setReady(true)
    │
    └─ if (!ready) return <SplashScreen />
       <I18nProvider instance={getI18n()}>
         <Stack />
       </I18nProvider>
```

**为什么先 init 再 render**：
i18next 必须在第一次 `t()` 调用前完成初始化，否则会拿到未初始化的 fallback 字符串。

### 切换语言

```
Settings → Language → 选 "中文（简体）"
    │
    ├─ setLang('zh')                  // 本地状态更新（UI 立即响应）
    │
    ├─ await saveUiLanguage('zh')     // 持久化
    │
    └─ await i18n.changeLanguage('zh')
          │
          └─ languageChanged 事件
                 │
                 └─ 所有 <T> 重渲染
```

## 错误处理

| 场景 | 处理 | 失败影响 |
|---|---|---|
| AsyncStorage 读取失败 | catch → 默认 `'system'` | 用户首次启动看不到自定义语言 |
| AsyncStorage 写入失败 | catch + warn，UI 立即切换仍生效 | 下次启动重置为上次成功值 |
| i18next init 抛错 | try/catch 包住 `initI18n`，fallback 用 `'en'` 资源 | 应用仍可启动，全部显示英文 |
| 翻译键缺失 | i18next `returnEmptyString: false` → fallback 到 `defaultValue` (children) | 显示英文原文 |
| Metro watchFolders 配错 | 构建/启动期报错 | 开发者立即可见 |
| `Localization.getLocales()` 抛错 | try/catch → fallback 到 `'en'` | system 模式变成英文 |
| v1 范围外语言（如 ja） | 用户无法选择 | 不影响 v1 体验 |

## 测试

### 单元测试（vitest）

1. **`mobile/src/i18n/T.test.tsx`** — `render(<T>...</T>)`：
   - 不传 `i18nKey`：渲染 `children` 原文
   - 传 `i18nKey` 且键存在：渲染翻译后文本
   - 传不存在的 `i18nKey`：渲染 `children` fallback
   - 模拟 `i18n.changeLanguage()`：组件重渲染并展示新语言

2. **`mobile/src/i18n/init.test.ts`** — 给 `'system' | 'zh' | 'en'` 各跑一次：
   - `system` + 模拟 `Localization.getLocales` 返回 `zh` → `i18n.language === 'zh'`
   - `system` + 模拟返回 `en` → `i18n.language === 'en'`
   - 显式 `'zh'` → `i18n.language === 'zh'`
   - 损坏资源（mock 抛错）→ 降级到 `'en'`，不抛错

3. **`mobile/src/storage/preferences.test.ts` 追加**：
   - `loadUiLanguage` 在 key 缺失时返回 `'system'`
   - `loadUiLanguage` 在损坏值时返回 `'system'`
   - `saveUiLanguage` + `loadUiLanguage` 往返一致
   - `loadUiLanguage` 在 AsyncStorage 抛错时返回 `'system'`

4. **`mobile/src/i18n/useT.test.ts`**：
   - 组件内调用 `useT()` 拿到 `t` 与 `resolvedLanguage`
   - `t('settings.title')` 在 zh locale 下返回中文

### 集成测试

复用 `tests/e2e/floating-mobile-emulator-tab.spec.ts` 同款 setup：
- 启动 App → 进 Settings → Language → 选 "中文（简体）" → 返回首页 → 断言可见 `设置` 等中文文案

### 验收清单

- [ ] `mobile/app/**/*.tsx` 全部 23 个路由文件接入 `<T>`（含 `_layout.tsx`）
- [ ] 主要组件（`NewWorktreeModal`、`CustomKeyModal`、`ActionSheetModal`、`ConfirmModal`、`TextInputModal` 等）接入 `<T>`
- [ ] Settings 屏有 Language 入口
- [ ] 切换语言后无需重启 App
- [ ] AsyncStorage 损坏数据不导致崩溃
- [ ] 翻译键缺失时显示英文 fallback
- [ ] metro.config.js 在本地 `pnpm start` 可正常热重载桌面端 zh.json 修改

## 不在范围内（YAGNI）

- ❌ 复数规则（`_one/_other`）— 中文不需要
- ❌ 翻译键的类型自动生成 — 桌面端也没做
- ❌ RTL 布局 — 项目不支持阿语
- ❌ 运行时 locale 变化监听 — 用户改系统语言后重启 App 即可
- ❌ 韩文 / 日文 / 西文切换 UI（v1 仅 zh/en/system 三选项）— 后续如需要再扩展
- ❌ 与桌面端双向同步 — 走独立设置

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| Metro `watchFolders` 改动影响开发体验 | 保留旧配置备份；如遇问题可回滚到 `mobile/` 单包模式并复制 zh.json |
| `expo-localization` 在 Expo Go 中需要 dev client | 项目已经声明 `expo-dev-client: ~55.0.35`，无新约束 |
| `<T>` 包装组件在 RN 上有性能开销 | 仅一个 `<Text>` 子树，影响可忽略 |
| 桌面端 zh.json 键名变更导致移动端文案错位 | 翻译键缺失会自动 fallback 到英文 children，不会崩溃 |

## 后续扩展路径（v2 候选）

- 暴露 ko/ja/es 切换
- 翻译键的 TypeScript 类型自动生成
- 与桌面端 RPC 同步 uiLanguage
- 翻译覆盖率审计脚本（`mobile/coverage-i18n.ts`）
