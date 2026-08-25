# Office 文件预览 (docx + xlsx) — 设计

日期: 2026-08-21
状态: Approved (brainstorming)

## 目标

扩展 Orca 现有预览能力,支持 `.docx` (Word) 与 `.xlsx` (Excel) 的只读预览。本地 + 远程 (SSH) workspace 同时覆盖。pptx 不在本期范围。

## 非目标 (YAGNI)

- 任何形式编辑/保存
- pptx 预览
- 公式重算 (显示 SheetJS 缓存的 last value, 不重算)
- 图表渲染
- 修订追踪、批注、目录、脚注
- 加密文件解密

## 决策记录

| 决策 | 选择 | 备选 |
|---|---|---|
| 解析位置 | 渲染层 (mammoth + SheetJS) | 主进程 LibreOffice 转 PDF |
| Sheet 切换 | 顶部 tab 切换 | 只显示第一张 / 纵向拼接 |
| 文件大小 | 10 MiB (复用图片/PDF 上限) | xlsx 50 MiB / 不限 |
| 组件组织 | 拆成 DocxViewer / XlsxViewer | 统一 OfficePreview |
| 远程支持 | 本地 + SSH | 仅本地 |
| 样式 | CSS Module + 现有 CSS 变量 | 内联 style |

## 架构

复用现有 image/PDF 预览的双切入点模式:

### 主进程改动

`src/main/runtime/orca-runtime-files.ts`:
- `RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES` 增加两项:
  - `.docx` -> `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - `.xlsx` -> `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `readFileExplorerPreview` 不变 — 已对白名单扩展返回 base64
- 10 MiB 上限沿用

### 渲染层改动

`src/renderer/src/components/editor/EditorContent.tsx`:
- 在 "Binary file — cannot display" 分支前按 `activeFile.relativePath` 扩展名 + `fc.mimeType` 判定 `.docx` / `.xlsx`
- 命中则分别 `React.lazy` 加载 `DocxViewer` / `XlsxViewer`
- 沿用现有 `ImageViewer` 懒加载模式

### 新增文件

- `src/renderer/src/components/editor/DocxViewer.tsx`
- `src/renderer/src/components/editor/XlsxViewer.tsx`
- `src/renderer/src/components/editor/OfficePreview.module.css`

### 依赖

`package.json`:
- `mammoth@^1.8.x`
- `xlsx@^0.18.x` (SheetJS Community Edition)

## 组件契约

### `DocxViewer`

```ts
interface DocxViewerProps {
  arrayBuffer: ArrayBuffer;
  fileName: string;
}
```

- 调 `mammoth.convertToHtml({ arrayBuffer }, { includeDefaultStyleMap: true })`
- 渲染 `<div className="office-preview">` 包裹 `dangerouslySetInnerHTML`
- 状态机: `loading` | `ready` | `error`
- 不实现: 目录、批注、修订、脚注、嵌入图片、复杂表格合并

### `XlsxViewer`

```ts
interface XlsxViewerProps {
  arrayBuffer: ArrayBuffer;
  fileName: string;
}
```

- 一次 `XLSX.read(arrayBuffer, { type: 'array', cellDates: true })` 解析
- 状态: `activeSheet` (默认 `SheetNames[0]`)、`sheets` (Map<name, rows[][]>)
- 顶部 sheet 标签栏 (shadcn `Tabs`/`TabsList`/`TabsTrigger`),横向滚动
- 主体 `<table>` 渲染当前 sheet,冻结首行/首列,数字右对齐,日期 `YYYY-MM-DD`
- 公式 cells: 显示 SheetJS 缓存的 last value, 字符串前缀 `=` 保留原文, 不重算

### `OfficePreview.module.css`

共享样式:
- `.office-preview` — max-width 900px、居中、padding、滚动
- `.office-preview table` — 边框、单元格 padding、odd 行斑马
- `.office-preview h1-h6` — 字号梯度(沿用 STYLEGUIDE typography tokens)
- `.sheet-tabs` — 横向 flex,tab 间距

所有颜色/间距走 `src/renderer/src/assets/main.css` 已有 CSS 变量,遵守 DESIGN system。

## 数据流

```
双击 .docx / .xlsx
  -> EditorContent dispatch (本次新增)
  -> XlsxViewer / DocxViewer mount
  -> useEffect: readRuntimeFilePreview(fileUri)
      -> 主进程 readFileExplorerPreview
          -> 扩展白名单命中 -> 读 buffer -> base64 -> 返回
      -> 渲染层 atob(base64) -> Uint8Array -> arrayBuffer
  -> mammoth / XLSX 解析
  -> 渲染 HTML / sheet 表格
  -> Sheet 切换: 复用已解析 workbook, 不重新 read
```

复用现有 `readRuntimeFilePreview` + `RuntimeFilePreviewResult` 契约, 不改 IPC 通道。

## 错误处理

| 场景 | 行为 |
|---|---|
| 文件 > 10 MiB | 主进程拒返, 显示 "文件过大, 无法预览 (上限 10 MiB)" |
| 扩展名不在白名单 | 走原 "Binary file — cannot display" 分支 |
| 解析抛错 (mammoth/XLSX) | 捕获 → `status: 'error'` → Alert "无法解析此文件, 可能已损坏或加密" |
| 加密/口令保护文件 | 解析抛错 → 走上一行 |
| 远程 SSH 路径读取失败 | `readRuntimeFilePreview` 抛错 → 沿用现有错误 Toast |
| xlsx 0 sheet | "空工作簿" |
| xlsx 单 sheet 0 行 | "空 sheet" |
| docx 内容为空 | mammoth 返回空字符串 → "文档为空" |

## 测试

### 单元测试

`src/main/runtime/__tests__/orca-runtime-files.preview.test.ts`:
- `RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES` 含 `.docx` / `.xlsx` 项且 MIME 字符串正确
- `readFileExplorerPreview` 对 12 MiB 的 `.docx` 抛 "too large" 错误
- `readFileExplorerPreview` 对合法 `.xlsx` 返回 base64 且包含 ZIP magic `PK\x03\x04`

`src/renderer/src/components/editor/__tests__/DocxViewer.test.tsx`:
- fixture docx-text → 容器含 "Hello"
- 损坏 `arrayBuffer` → 渲染 error Alert, 无 crash

`src/renderer/src/components/editor/__tests__/XlsxViewer.test.tsx`:
- 3-sheet xlsx → 渲染 3 个 `TabsTrigger`
- 点击 sheet[2] → 表格内容匹配 sheet[2]
- 空 sheet → "空 sheet" 文案

### Fixture

`src/renderer/src/components/editor/__tests__/fixtures/`:
- `tiny.docx` (最小合法 docx)
- `tiny.xlsx` (3 sheet)
- `empty.xlsx` (空 sheet)

二进制文件 <8KB, 直 commit, 不用 git lfs。

### 手动验证 ($electron + Playwright)

- 启动 dev, 打开仓库内 `test-assets/sample.docx` → 截图比对
- 切换 sheet tab → 截图
- 损坏文件 → 截图 error UI
- SSH 沙箱: 同样三步

### 回归

PNG / JPG / PDF / MD / Mermaid / Csv / Ipynb 全部手动回归, 防 dispatch 分支错位。

### 不做

- 全量边界 fuzz (YAGNI)
- 性能基准 (Ponytail: 出瓶颈再加)

## 改动清单

新增:
- `src/renderer/src/components/editor/DocxViewer.tsx`
- `src/renderer/src/components/editor/XlsxViewer.tsx`
- `src/renderer/src/components/editor/OfficePreview.module.css`
- `src/renderer/src/components/editor/__tests__/DocxViewer.test.tsx`
- `src/renderer/src/components/editor/__tests__/XlsxViewer.test.tsx`
- `src/renderer/src/components/editor/__tests__/fixtures/{tiny.docx,tiny.xlsx,empty.xlsx}`
- `src/main/runtime/__tests__/orca-runtime-files.preview.test.ts`

修改:
- `src/main/runtime/orca-runtime-files.ts` (扩白名单)
- `src/renderer/src/components/editor/EditorContent.tsx` (新增 dispatch 分支)
- `package.json` (加 mammoth + xlsx)

不动:
- `src/renderer/src/lib/language-detect.ts`
- `src/renderer/src/components/editor/editor-panel-render-model.ts`
- `src/main/runtime/runtime-rpc.ts`
- `src/renderer/src/runtime/runtime-file-client.ts`
