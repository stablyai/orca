---
title: Enable isolatedDeclarations for Parallel Declaration Emit
impact: CRITICAL
impactDescription: enables parallel .d.ts generation without type-checker
tags: tscfg, isolatedDeclarations, declarations, parallel, performance
---

## Enable isolatedDeclarations for Parallel Declaration Emit

The `isolatedDeclarations` flag (TypeScript 5.5+) ensures each file's exports are annotated sufficiently for tools to generate `.d.ts` files without running the type-checker. This enables parallel declaration emit via bundlers and dramatically speeds up builds in large codebases.

**Incorrect (declaration emit requires full type-check):**

```json
{
  "compilerOptions": {
    "declaration": true
  }
}
```

```typescript
// utils.ts
export function calculateTotal(items: CartItem[]) {
  // Return type inferred — requires type-checker to generate .d.ts
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}
```

**Correct (explicit annotations enable parallel emit):**

```json
{
  "compilerOptions": {
    "declaration": true,
    "isolatedDeclarations": true
  }
}
```

```typescript
// utils.ts
export function calculateTotal(items: CartItem[]): number {
  // Explicit return type — .d.ts can be generated per-file, in parallel
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}
```

**What requires annotation under isolatedDeclarations:**
- Exported function return types
- Exported variable types when not inferable from a literal
- Exported class method return types

**What does NOT need annotation:**
- Local variables and functions (not exported)
- Function parameters (already required by TypeScript)
- Exports initialized with literals (`export const MAX = 100` is fine)

**Pair with isolatedModules for maximum build speed:**

```json
{
  "compilerOptions": {
    "isolatedModules": true,
    "isolatedDeclarations": true,
    "declaration": true
  }
}
```

Reference: [TypeScript 5.5 - Isolated Declarations](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-5.html#isolated-declarations)
