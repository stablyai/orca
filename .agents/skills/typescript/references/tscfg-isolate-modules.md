---
title: Use isolatedModules for Single-File Transpilation
impact: CRITICAL
impactDescription: 80-90% faster transpilation with bundlers
tags: tscfg, isolatedModules, transpilation, bundlers, performance
---

## Use isolatedModules for Single-File Transpilation

The `isolatedModules` flag ensures each file can be transpiled independently, enabling parallel transpilation by bundlers like esbuild, swc, or Babel. This bypasses TypeScript's slower multi-file analysis.

**Incorrect (requires cross-file analysis):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext"
  }
}
```

```typescript
// constants.ts
export const enum Status {
  Active = 'active',
  Inactive = 'inactive'
}

// user.ts
import { Status } from './constants'
const status = Status.Active  // Requires reading constants.ts to inline
```

**Correct (single-file transpilable):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

```typescript
// constants.ts
export enum Status {  // Regular enum, not const enum
  Active = 'active',
  Inactive = 'inactive'
}

// user.ts
import { Status } from './constants'
const status = Status.Active  // Reference preserved, no cross-file read
```

**Build pipeline integration:**

```javascript
// vite.config.ts
export default {
  esbuild: {
    // esbuild transpiles files in parallel
    // TypeScript only runs type-checking
  }
}
```

**Code patterns blocked by isolatedModules:**
- `const enum` (use regular `enum` or union types instead)
- `export =` / `import =` syntax
- Re-exporting types without `type` keyword

**Note:** With `erasableSyntaxOnly` (TypeScript 5.8+), regular enums are also blocked. Use union types (`type Status = 'active' | 'inactive'`) as the universal safe alternative. See `tscfg-erasable-syntax-only.md`.

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#isolated-file-emit)
