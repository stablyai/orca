---
title: Enable strictFunctionTypes for Faster Variance Checks
impact: CRITICAL
impactDescription: enables optimized variance checking
tags: tscfg, strict, strictFunctionTypes, variance, performance
---

## Enable strictFunctionTypes for Faster Variance Checks

With `strictFunctionTypes` enabled, TypeScript uses fast variance-based checking for function parameters. Without it, TypeScript falls back to slower structural comparison for every function type.

**Incorrect (slow structural checking):**

```json
{
  "compilerOptions": {
    "strict": false,
    "strictFunctionTypes": false
  }
}
```

```typescript
type Handler<T> = (event: T) => void

// Without strictFunctionTypes, TypeScript uses bidirectional
// (bivariant) checking - comparing structures both ways
const handler: Handler<MouseEvent> = (e: Event) => { }  // Allowed but unsafe
```

**Correct (fast variance checking):**

```json
{
  "compilerOptions": {
    "strict": true
  }
}
```

```typescript
type Handler<T> = (event: T) => void

// With strictFunctionTypes, TypeScript uses contravariant
// checking for parameters - faster and type-safe
const handler: Handler<MouseEvent> = (e: Event) => { }  // Error: Event is not MouseEvent
```

**Note:** The `strict` flag enables `strictFunctionTypes` along with other strict options. Enable `strict` for all new projects.

**When bivariance is needed:**

```typescript
// Use method syntax for intentional bivariance
interface EventEmitter<T> {
  emit(event: T): void  // Method syntax = bivariant
}

// vs property syntax for contravariance
interface StrictEmitter<T> {
  emit: (event: T) => void  // Property syntax = contravariant
}
```

Reference: [TypeScript 2.6 - Strict Function Types](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-6.html#strict-function-types)
