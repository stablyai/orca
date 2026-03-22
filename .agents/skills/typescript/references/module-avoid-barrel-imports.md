---
title: Avoid Barrel File Imports
impact: HIGH
impactDescription: 200-800ms import cost, 30-50% larger bundles
tags: module, barrel-files, imports, tree-shaking, bundling
---

## Avoid Barrel File Imports

Barrel files (index.ts re-exports) defeat tree-shaking and force bundlers to load entire module graphs. Import directly from source files to enable proper dead-code elimination.

**Incorrect (imports entire module tree):**

```typescript
// utils/index.ts (barrel file)
export * from './string'
export * from './date'
export * from './validation'
export * from './crypto'  // Heavy, rarely used

// consumer.ts
import { formatDate } from '@/utils'
// Loads ALL utils modules, including crypto
// Bundle includes 50KB of unused code
```

**Correct (direct imports):**

```typescript
// consumer.ts
import { formatDate } from '@/utils/date'
// Loads only the date module
// Bundle includes only what's used
```

**For icon libraries (common barrel offender):**

```typescript
// Incorrect - loads all 1500+ icons
import { Check, X } from 'lucide-react'

// Correct - loads only 2 icons
import Check from 'lucide-react/dist/esm/icons/check'
import X from 'lucide-react/dist/esm/icons/x'
```

**Alternative (configure bundler optimization):**

```javascript
// next.config.js
module.exports = {
  experimental: {
    optimizePackageImports: ['lucide-react', '@mui/material', 'lodash']
  }
}

// vite.config.ts
export default {
  optimizeDeps: {
    include: ['lucide-react']
  }
}
```

**When barrels are acceptable:**
- Internal modules with few exports (< 10)
- Package entry points for library consumers
- When bundler is configured to optimize them

Reference: [Vercel - How we optimized package imports](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js)
