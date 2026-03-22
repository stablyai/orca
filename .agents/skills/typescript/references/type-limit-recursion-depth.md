---
title: Limit Type Recursion Depth
impact: HIGH
impactDescription: prevents exponential type expansion when applicable
tags: type, recursion, generics, depth, performance
---

## Limit Type Recursion Depth

Recursive types without depth limits can cause exponential type expansion, leading to compilation hangs or out-of-memory errors. Add explicit depth counters or use tail-recursive patterns.

**Incorrect (unbounded recursion):**

```typescript
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}
// No depth limit - deeply nested objects cause exponential expansion

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue }
// Infinite recursion potential
```

**Correct (bounded recursion with depth counter):**

```typescript
type DeepPartial<T, Depth extends number[] = []> = Depth['length'] extends 5
  ? T  // Stop at depth 5
  : {
      [P in keyof T]?: T[P] extends object
        ? DeepPartial<T[P], [...Depth, 1]>
        : T[P]
    }

type JSONValue<Depth extends number[] = []> = Depth['length'] extends 10
  ? unknown
  : | string
    | number
    | boolean
    | null
    | JSONValue<[...Depth, 1]>[]
    | { [key: string]: JSONValue<[...Depth, 1]> }
```

**Alternative (use built-in utilities):**

```typescript
// For simple cases, prefer built-in Partial over custom DeepPartial
type Config = Partial<AppConfig>

// Use libraries like ts-toolbelt for complex recursive types
// They implement optimized depth-limited versions
```

**When unbounded recursion is acceptable:**
- Types with guaranteed shallow depth (max 2-3 levels)
- Internal types not exposed in public APIs

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance)
