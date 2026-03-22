---
title: Use Dynamic Imports for Large Modules
impact: HIGH
impactDescription: reduces initial bundle by 30-70%
tags: module, dynamic-import, code-splitting, lazy-loading, bundling
---

## Use Dynamic Imports for Large Modules

Dynamic `import()` creates separate chunks that load on demand. Use them for large dependencies, route-specific code, and features that aren't needed immediately.

**Incorrect (static import, always loaded):**

```typescript
import { PDFGenerator } from 'pdfkit'  // 500KB
import { ExcelExporter } from 'exceljs'  // 800KB
import { ChartLibrary } from 'chart.js'  // 300KB

export async function exportReport(format: 'pdf' | 'excel' | 'chart') {
  if (format === 'pdf') {
    return new PDFGenerator().generate()
  }
  // All 1.6MB loaded even if user never exports
}
```

**Correct (dynamic import, loaded on demand):**

```typescript
export async function exportReport(format: 'pdf' | 'excel' | 'chart') {
  if (format === 'pdf') {
    const { PDFGenerator } = await import('pdfkit')
    return new PDFGenerator().generate()
  }

  if (format === 'excel') {
    const { ExcelExporter } = await import('exceljs')
    return new ExcelExporter().export()
  }

  const { ChartLibrary } = await import('chart.js')
  return new ChartLibrary().render()
}
// Only loads the module needed for the specific format
```

**With TypeScript typing:**

```typescript
async function loadPdfGenerator(): Promise<typeof import('pdfkit')> {
  return import('pdfkit')
}

// Or with type-only import for the interface
import type { PDFDocument } from 'pdfkit'

async function generatePdf(): Promise<PDFDocument> {
  const { default: PDFDocument } = await import('pdfkit')
  return new PDFDocument()
}
```

**Framework-specific patterns:**

```typescript
// Next.js
import dynamic from 'next/dynamic'

const HeavyChart = dynamic(() => import('@/components/HeavyChart'), {
  loading: () => <ChartSkeleton />,
  ssr: false  // Skip server-side rendering
})

// React
const HeavyChart = React.lazy(() => import('@/components/HeavyChart'))
```

Reference: [MDN Dynamic Import](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import)
