# Office 文件预览 (docx + xlsx) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Orca 现有预览通道里, 给 `.docx` 和 `.xlsx` 加上只读预览 (本地 + 远程 SSH), 沿用 image/PDF 模式。

**Architecture:** 主进程白名单扩展 → 渲染层 `EditorContent` 加两个 dispatch 分支 → 新 `DocxViewer` / `XlsxViewer` 用 mammoth + SheetJS 解析 → sheet 切换 tab 在渲染层内部状态管理。

**Tech Stack:** `mammoth@^1.8.x` (docx 解析), `xlsx@^0.18.x` (SheetJS), `docx@^9.x` (dev, fixture 生成), React 18, shadcn Tabs, 现有 Vitest + RTL。

---

## 任务清单

### Task 1: 加 npm 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装运行时依赖**

```bash
pnpm add mammoth@^1.8.0 xlsx@^0.18.5
```

- [ ] **Step 2: 安装 fixture 生成用 dev 依赖**

```bash
pnpm add -D docx@^9.0.0
```

- [ ] **Step 3: 验证安装**

```bash
node -e "console.log(require('mammoth').convertToHtml, typeof require('xlsx').read, typeof require('docx').Document)"
```

Expected: 三个函数都打印, 无 error。

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add mammoth, xlsx, docx for office preview"
```

---

### Task 2: 扩展 MIME 白名单 (TDD)

**Files:**
- Modify: `src/main/runtime/orca-runtime-files.ts:114-165`
- Test: `src/main/runtime/__tests__/orca-runtime-files.preview.test.ts`

- [ ] **Step 1: 写测试 — 白名单包含 docx / xlsx**

`src/main/runtime/__tests__/orca-runtime-files.preview.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES } from '../orca-runtime-files'

describe('RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES', () => {
  it('includes office open xml word (.docx)', () => {
    expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES['.docx']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  })

  it('includes office open xml spreadsheet (.xlsx)', () => {
    expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES['.xlsx']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  })

  it('still includes existing image and pdf types', () => {
    expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES['.pdf']).toBe('application/pdf')
    expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES['.png']).toBe('image/png')
  })
})
```

- [ ] **Step 2: 运行测试, 确认失败**

```bash
pnpm vitest run src/main/runtime/__tests__/orca-runtime-files.preview.test.ts
```

Expected: FAIL — `RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES` 当前不含 `.docx` / `.xlsx`。

- [ ] **Step 3: 实现 — 在 `RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES` 内加两项**

打开 `src/main/runtime/orca-runtime-files.ts`, 找到 `RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES` const 对象 (大约 114-165 行)。在现有 `.pdf` 条目**后面**新增:

```ts
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
```

保持原表项不变, 字段顺序按字母。

- [ ] **Step 4: 再跑测试, 确认通过**

```bash
pnpm vitest run src/main/runtime/__tests__/orca-runtime-files.preview.test.ts
```

Expected: 3 个 `it` 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/runtime/orca-runtime-files.ts src/main/runtime/__tests__/orca-runtime-files.preview.test.ts
git commit -m "feat(preview): whitelist .docx and .xlsx for binary preview"
```

---

### Task 3: 生成 Office 测试 fixtures

**Files:**
- Create: `scripts/gen-office-fixtures.ts`
- Create: `src/renderer/src/components/editor/__tests__/fixtures/tiny.docx`
- Create: `src/renderer/src/components/editor/__tests__/fixtures/tiny.xlsx`
- Create: `src/renderer/src/components/editor/__tests__/fixtures/empty.xlsx`

- [ ] **Step 1: 写 fixture 生成脚本**

`scripts/gen-office-fixtures.ts`:

```ts
import { Document, Packer, Paragraph, TextRun } from 'docx'
import * as XLSX from 'xlsx'
import * as fs from 'node:fs'
import * as path from 'node:path'

const FIXTURE_DIR = path.join(
  __dirname,
  '../src/renderer/src/components/editor/__tests__/fixtures'
)

async function writeDocx(): Promise<void> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun('Hello office preview')]
          }),
          new Paragraph({
            children: [new TextRun('Second paragraph for tab traversal')]
          })
        ]
      }
    ]
  })
  const buffer = await Packer.toBuffer(doc)
  fs.writeFileSync(path.join(FIXTURE_DIR, 'tiny.docx'), buffer)
}

function writeXlsx(): void {
  const wb = XLSX.utils.book_new()
  const sheet1 = XLSX.utils.aoa_to_sheet([
    ['A1', 'B1', 'C1'],
    ['1', '2', '3'],
    ['4', '5', '6']
  ])
  const sheet2 = XLSX.utils.aoa_to_sheet([
    ['x', 'y'],
    ['7', '8']
  ])
  const sheet3 = XLSX.utils.aoa_to_sheet([['only-on-sheet-3']])
  XLSX.utils.book_append_sheet(wb, sheet1, 'First')
  XLSX.utils.book_append_sheet(wb, sheet2, 'Second')
  XLSX.utils.book_append_sheet(wb, sheet3, 'Third')
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  fs.writeFileSync(path.join(FIXTURE_DIR, 'tiny.xlsx'), buffer)
}

function writeEmptyXlsx(): void {
  const wb = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([[]])
  XLSX.utils.book_append_sheet(wb, sheet, 'Empty')
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  fs.writeFileSync(path.join(FIXTURE_DIR, 'empty.xlsx'), buffer)
}

async function main(): Promise<void> {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  await writeDocx()
  writeXlsx()
  writeEmptyXlsx()
  console.log('fixtures written to', FIXTURE_DIR)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: 跑脚本生成 fixtures**

```bash
npx tsx scripts/gen-office-fixtures.ts
```

Expected: 输出 `fixtures written to ...`, 三个文件存在。

- [ ] **Step 3: 验证 fixtures 字节数**

```bash
ls -la src/renderer/src/components/editor/__tests__/fixtures/
```

Expected: 三个文件都 < 10 KB。

- [ ] **Step 4: 验证 fixture 合法性**

```bash
node -e "
const XLSX = require('xlsx')
const wb = XLSX.readFile('src/renderer/src/components/editor/__tests__/fixtures/tiny.xlsx')
console.log('sheets:', wb.SheetNames)
console.log('First sheet row 0:', XLSX.utils.sheet_to_json(wb.Sheets.First, { header: 1 })[0])
"
```

Expected: `sheets: [ 'First', 'Second', 'Third' ]`, First sheet row 0 = `['A1', 'B1', 'C1']`。

- [ ] **Step 5: Commit**

```bash
git add -f scripts/gen-office-fixtures.ts src/renderer/src/components/editor/__tests__/fixtures/
git commit -m "test: add office preview fixtures (tiny.docx, tiny.xlsx, empty.xlsx)"
```

---

### Task 4: DocxViewer — TDD

**Files:**
- Create: `src/renderer/src/components/editor/DocxViewer.tsx`
- Create: `src/renderer/src/components/editor/__tests__/DocxViewer.test.tsx`
- Create: `src/renderer/src/components/editor/OfficePreview.module.css`

- [ ] **Step 1: 写最小 CSS Module (DocxViewer 必需)**

`src/renderer/src/components/editor/OfficePreview.module.css`:

```css
.officePreview {
  max-width: 900px;
  margin: 0 auto;
  padding: 16px 24px;
  overflow: auto;
  color: var(--text-primary, #1f2328);
  background: var(--bg-primary, #ffffff);
}

.officePreview h1 { font-size: 24px; margin: 16px 0 8px; }
.officePreview h2 { font-size: 20px; margin: 14px 0 6px; }
.officePreview h3 { font-size: 16px; margin: 12px 0 4px; }
.officePreview p  { margin: 8px 0; line-height: 1.5; }
.officePreview ul, .officePreview ol { padding-left: 24px; margin: 8px 0; }
.officePreview table { border-collapse: collapse; width: 100%; margin: 12px 0; }
.officePreview th, .officePreview td {
  border: 1px solid var(--border-default, #d0d7de);
  padding: 6px 10px;
  text-align: left;
}
.officePreview tr:nth-child(even) td {
  background: var(--bg-secondary, #f6f8fa);
}

.errorBox {
  max-width: 600px;
  margin: 24px auto;
  padding: 16px;
  border: 1px solid var(--border-error, #cf222e);
  border-radius: 6px;
  color: var(--text-error, #cf222e);
  background: var(--bg-error, #ffebe9);
}
```

- [ ] **Step 2: 写失败测试 — 正常 fixture + 损坏 buffer**

`src/renderer/src/components/editor/__tests__/DocxViewer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFilePreview: vi.fn()
}))

import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import { DocxViewer } from '../DocxViewer'

const FIXTURE = path.join(__dirname, 'fixtures', 'tiny.docx')

function readFixture(): ArrayBuffer {
  const buf = fs.readFileSync(FIXTURE)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

function toBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab)
  let bin = ''
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i])
  return Buffer.from(bin, 'binary').toString('base64')
}

describe('DocxViewer', () => {
  beforeEach(() => {
    vi.mocked(readRuntimeFilePreview).mockReset()
  })

  it('renders html from a valid docx fixture', async () => {
    vi.mocked(readRuntimeFilePreview).mockResolvedValue({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: toBase64(readFixture())
    })
    render(<DocxViewer fileUri="file:///tiny.docx" fileName="tiny.docx" />)
    await waitFor(
      () => {
        expect(screen.getByText(/Hello office preview/)).toBeInTheDocument()
      },
      { timeout: 3000 }
    )
  })

  it('shows error alert for a corrupted buffer', async () => {
    vi.mocked(readRuntimeFilePreview).mockResolvedValue({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: toBase64(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer)
    })
    render(<DocxViewer fileUri="file:///bad.docx" fileName="bad.docx" />)
    await waitFor(
      () => {
        expect(screen.getByText(/无法解析/)).toBeInTheDocument()
      },
      { timeout: 3000 }
    )
  })
})
```

- [ ] **Step 3: 跑测试, 确认失败**

```bash
pnpm vitest run src/renderer/src/components/editor/__tests__/DocxViewer.test.tsx
```

Expected: FAIL — `DocxViewer` 模块不存在。

- [ ] **Step 4: 实现 DocxViewer**

`src/renderer/src/components/editor/DocxViewer.tsx`:

```tsx
import { useEffect, useState } from 'react'
import * as mammoth from 'mammoth'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import styles from './OfficePreview.module.css'

export interface DocxViewerProps {
  fileUri: string
  fileName: string
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; html: string }
  | { kind: 'error'; message: string }

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

export function DocxViewer({ fileUri, fileName }: DocxViewerProps): JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setStatus({ kind: 'loading' })
    readRuntimeFilePreview(fileUri)
      .then(async (preview) => {
        const buffer = base64ToArrayBuffer(preview.base64)
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buffer },
          { includeDefaultStyleMap: true }
        )
        if (cancelled) return
        if (!result.value) {
          setStatus({ kind: 'ready', html: '<p>文档为空</p>' })
          return
        }
        setStatus({ kind: 'ready', html: result.value })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setStatus({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [fileUri])

  if (status.kind === 'loading') {
    return <div className={styles.officePreview}>Loading {fileName}…</div>
  }

  if (status.kind === 'error') {
    return (
      <div className={styles.errorBox} role="alert">
        无法解析此 .docx 文件, 可能已损坏或加密。
      </div>
    )
  }

  return (
    <div
      className={styles.officePreview}
      data-testid="docx-preview"
      dangerouslySetInnerHTML={{ __html: status.html }}
    />
  )
}
```

- [ ] **Step 5: 跑测试, 确认通过**

```bash
pnpm vitest run src/renderer/src/components/editor/__tests__/DocxViewer.test.tsx
```

Expected: 2 个 `it` 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/editor/DocxViewer.tsx src/renderer/src/components/editor/OfficePreview.module.css src/renderer/src/components/editor/__tests__/DocxViewer.test.tsx
git commit -m "feat(preview): add DocxViewer with mammoth renderer"
```

---

### Task 5: XlsxViewer — TDD

**Files:**
- Create: `src/renderer/src/components/editor/XlsxViewer.tsx`
- Modify: `src/renderer/src/components/editor/OfficePreview.module.css`
- Create: `src/renderer/src/components/editor/__tests__/XlsxViewer.test.tsx`

- [ ] **Step 1: 加 sheet tab 样式到 CSS Module**

在 `src/renderer/src/components/editor/OfficePreview.module.css` 末尾追加:

```css
.sheetTabs {
  display: flex;
  flex-direction: row;
  gap: 4px;
  padding: 8px 24px 0;
  border-bottom: 1px solid var(--border-default, #d0d7de);
  overflow-x: auto;
  background: var(--bg-secondary, #f6f8fa);
}

.sheetTab {
  padding: 6px 12px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  background: transparent;
  color: var(--text-secondary, #57606a);
  white-space: nowrap;
}

.sheetTab[data-active='true'] {
  background: var(--bg-primary, #ffffff);
  border-color: var(--border-default, #d0d7de);
  color: var(--text-primary, #1f2328);
  font-weight: 600;
}

.cellNumber { text-align: right; font-variant-numeric: tabular-nums; }
.emptyMsg {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary, #57606a);
}
```

- [ ] **Step 2: 写失败测试 — 3 sheet tab + 切换 + empty sheet + error**

`src/renderer/src/components/editor/__tests__/XlsxViewer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFilePreview: vi.fn()
}))

import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import { XlsxViewer } from '../XlsxViewer'

const FIXTURE_DIR = path.join(__dirname, 'fixtures')

function readFixture(name: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(FIXTURE_DIR, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

function toBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab)
  let bin = ''
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i])
  return Buffer.from(bin, 'binary').toString('base64')
}

function mockRead(name: string): void {
  vi.mocked(readRuntimeFilePreview).mockResolvedValue({
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: toBase64(readFixture(name))
  })
}

describe('XlsxViewer', () => {
  beforeEach(() => {
    vi.mocked(readRuntimeFilePreview).mockReset()
  })

  it('renders three tabs for a three-sheet workbook', async () => {
    mockRead('tiny.xlsx')
    render(<XlsxViewer fileUri="file:///tiny.xlsx" fileName="tiny.xlsx" />)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'First' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Second' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Third' })).toBeInTheDocument()
    })
  })

  it('shows first sheet content by default', async () => {
    mockRead('tiny.xlsx')
    render(<XlsxViewer fileUri="file:///tiny.xlsx" fileName="tiny.xlsx" />)
    await waitFor(() => {
      expect(screen.getByText('A1')).toBeInTheDocument()
    })
  })

  it('switches to the clicked sheet and renders its content', async () => {
    mockRead('tiny.xlsx')
    render(<XlsxViewer fileUri="file:///tiny.xlsx" fileName="tiny.xlsx" />)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Third' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Third' }))
    await waitFor(() => {
      expect(screen.getByText('only-on-sheet-3')).toBeInTheDocument()
    })
  })

  it('shows empty message for a sheet with no rows', async () => {
    mockRead('empty.xlsx')
    render(<XlsxViewer fileUri="file:///empty.xlsx" fileName="empty.xlsx" />)
    await waitFor(() => {
      expect(screen.getByText(/空 sheet/)).toBeInTheDocument()
    })
  })

  it('shows error alert for a corrupted buffer', async () => {
    vi.mocked(readRuntimeFilePreview).mockResolvedValue({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: toBase64(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer)
    })
    render(<XlsxViewer fileUri="file:///bad.xlsx" fileName="bad.xlsx" />)
    await waitFor(() => {
      expect(screen.getByText(/无法解析/)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 3: 跑测试, 确认失败**

```bash
pnpm vitest run src/renderer/src/components/editor/__tests__/XlsxViewer.test.tsx
```

Expected: FAIL — `XlsxViewer` 模块不存在。

- [ ] **Step 4: 实现 XlsxViewer**

`src/renderer/src/components/editor/XlsxViewer.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import styles from './OfficePreview.module.css'

export interface XlsxViewerProps {
  fileUri: string
  fileName: string
}

type SheetData = {
  name: string
  rows: Array<Array<string | number | null>>
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; sheets: SheetData[] }
  | { kind: 'error'; message: string }

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const yyyy = value.getFullYear()
    const mm = String(value.getMonth() + 1).padStart(2, '0')
    const dd = String(value.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  return String(value)
}

export function XlsxViewer({ fileUri, fileName }: XlsxViewerProps): JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [activeSheet, setActiveSheet] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    setStatus({ kind: 'loading' })
    readRuntimeFilePreview(fileUri)
      .then((preview) => {
        const buffer = base64ToArrayBuffer(preview.base64)
        const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
        const sheets: SheetData[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name]
          const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
            header: 1,
            raw: false,
            defval: ''
          }) as Array<Array<string | number | null>>
          return { name, rows }
        })
        if (cancelled) return
        setStatus({ kind: 'ready', sheets })
        setActiveSheet(sheets[0]?.name ?? '')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setStatus({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [fileUri])

  const current = useMemo(
    () =>
      status.kind === 'ready'
        ? status.sheets.find((s) => s.name === activeSheet)
        : undefined,
    [status, activeSheet]
  )

  if (status.kind === 'loading') {
    return <div className={styles.officePreview}>Loading {fileName}…</div>
  }

  if (status.kind === 'error') {
    return (
      <div className={styles.errorBox} role="alert">
        无法解析此 .xlsx 文件, 可能已损坏或加密。
      </div>
    )
  }

  if (status.sheets.length === 0) {
    return <div className={styles.emptyMsg}>空工作簿</div>
  }

  return (
    <div>
      <div className={styles.sheetTabs} role="tablist">
        {status.sheets.map((s) => (
          <button
            key={s.name}
            role="tab"
            aria-selected={s.name === activeSheet}
            data-active={s.name === activeSheet}
            className={styles.sheetTab}
            onClick={() => setActiveSheet(s.name)}
          >
            {s.name}
          </button>
        ))}
      </div>
      {current && current.rows.length === 0 ? (
        <div className={styles.emptyMsg}>空 sheet</div>
      ) : (
        <div className={styles.officePreview}>
          <table>
            <tbody>
              {current?.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={typeof cell === 'number' ? styles.cellNumber : undefined}
                    >
                      {formatCell(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: 跑测试, 确认通过**

```bash
pnpm vitest run src/renderer/src/components/editor/__tests__/XlsxViewer.test.tsx
```

Expected: 5 个 `it` 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/editor/XlsxViewer.tsx src/renderer/src/components/editor/OfficePreview.module.css src/renderer/src/components/editor/__tests__/XlsxViewer.test.tsx
git commit -m "feat(preview): add XlsxViewer with sheet tabs"
```

---

### Task 6: 挂到 EditorContent dispatch

**Files:**
- Modify: `src/renderer/src/components/editor/EditorContent.tsx:40-45, 501-512, 747-756`

- [ ] **Step 1: 找现有 lazy import 块**

打开 `src/renderer/src/components/editor/EditorContent.tsx`, 在 40-45 行附近 (现有 `React.lazy` import 区) 找到现有 `MarkdownPreview` / `ImageViewer` 等 lazy import。在同一 lazy 块后追加:

```tsx
const DocxViewer = React.lazy(() =>
  import('./DocxViewer').then((m) => ({ default: m.DocxViewer }))
)
const XlsxViewer = React.lazy(() =>
  import('./XlsxViewer').then((m) => ({ default: m.XlsxViewer }))
)
```

- [ ] **Step 2: 在 first content dispatch (501-512 行附近) 加 docx/xlsx 分支**

在该 dispatch 块内, **之前** `fc.isBinary && fc.isImage ? <ImageViewer>` 这一行, 插入:

```tsx
  if (fc.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return (
      <React.Suspense fallback={<div>Loading…</div>}>
        <DocxViewer fileUri={fc.fileUri} fileName={fc.relativePath ?? 'document.docx'} />
      </React.Suspense>
    )
  }
  if (fc.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return (
      <React.Suspense fallback={<div>Loading…</div>}>
        <XlsxViewer fileUri={fc.fileUri} fileName={fc.relativePath ?? 'spreadsheet.xlsx'} />
      </React.Suspense>
    )
  }
```

> **前提** — `FileContent` 必须已经暴露 `fileUri: string` 和 `mimeType: string`。如果当前 only exposes `isImage` boolean, 先在 `FileContent` interface 加这两个字段, 默认值兜底成 `''` / `undefined`。Orca 当前 `FileContent` 已含 `mimeType` (镜像预览用过), `fileUri` 是 `fc` 父对象的 `relativePath` + workspace root 拼出来的 — 实际接口名以代码为准。改 dispatch 时按真实字段名替换 `fileUri` / `relativePath`。

- [ ] **Step 3: 跑单元测试, 确认无回归**

```bash
pnpm vitest run src/renderer/src/components/editor/
```

Expected: 现有 markdown / image / ipynb 测试仍 PASS, 新 viewer 测试仍 PASS。

- [ ] **Step 4: 类型检查**

```bash
pnpm tsc -p src/renderer/tsconfig.json --noEmit
```

Expected: 0 errors。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/editor/EditorContent.tsx
git commit -m "feat(preview): route .docx and .xlsx to new viewers in EditorContent"
```

---

### Task 7: 手动验证 + 回归

**Files:** (no code changes, verification only)

- [ ] **Step 1: 启动 dev**

```bash
pnpm dev
```

Expected: Electron 启动, 无 runtime error.

- [ ] **Step 2: 用 sample 文件验证**

复制 fixture 到 user-accessible 路径:

```bash
mkdir -p ~/Desktop/orca-preview-test
cp src/renderer/src/components/editor/__tests__/fixtures/* ~/Desktop/orca-preview-test/
```

在 Orca 打开任一 git workspace, 把 `~/Desktop/orca-preview-test/tiny.docx` 拖入 editor。Expected: 渲染 HTML, 见到 "Hello office preview"。

- [ ] **Step 3: 验证 sheet 切换**

打开 `tiny.xlsx`, 顶部出现 First / Second / Third 三个 tab。点击 `Third`, 表格显示 "only-on-sheet-3"。

- [ ] **Step 4: 验证错误 UI**

构造一个损坏 docx:

```bash
printf 'not a real docx' > ~/Desktop/orca-preview-test/bad.docx
```

打开, 见到红色 error box "无法解析…"

- [ ] **Step 5: 回归现有预览**

依次打开 `.png` / `.pdf` / `.md` / `.csv` / `.ipynb` 文件, 确认仍正常渲染。

- [ ] **Step 6: 截图归档**

手动截图 3 张 (docx 正常 / xlsx sheet 切换 / error UI), 贴到 PR description 或本地 `docs/superpowers/plans/2026-08-21-office-preview-screenshots/` (选其一)。

- [ ] **Step 7: 跳过的代码生成注释**

确认 `EditorContent.tsx` 加了 inline 注释说明 office preview 路由:

```tsx
// ponytail: office preview path; mirrors ImageViewer mime gate, add pptx the same way when needed
```

- [ ] **Step 8: 最终 commit**

```bash
git add -A
git diff --cached --stat
git commit -m "docs: archive office preview screenshots" --allow-empty
```

---

## 任务总览

| # | 任务 | 估时 | 提交 |
|---|---|---|---|
| 1 | 加依赖 | 2 min | `chore(deps)` |
| 2 | 扩白名单 (TDD) | 5 min | `feat(preview): whitelist` |
| 3 | 生成 fixtures | 5 min | `test: add fixtures` |
| 4 | DocxViewer (TDD) | 10 min | `feat(preview): DocxViewer` |
| 5 | XlsxViewer (TDD) | 15 min | `feat(preview): XlsxViewer` |
| 6 | 挂 EditorContent | 10 min | `feat(preview): route` |
| 7 | 手动验证 | 10 min | `docs: screenshots` |

总计 ~57 min。8 个原子 commit, 全部 TDD (除手动验证)。
