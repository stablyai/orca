---
title: Simplify Complex Mapped Types
impact: HIGH
impactDescription: reduces type computation by 50-80% when applicable
tags: type, mapped-types, simplification, utility-types, performance
---

## Simplify Complex Mapped Types

Overly complex mapped types with multiple conditional branches slow compilation significantly. Break them into smaller, focused utility types and compose them.

**Incorrect (monolithic mapped type):**

```typescript
type ComplexTransform<T> = {
  [K in keyof T]: T[K] extends Function
    ? T[K]
    : T[K] extends Array<infer U>
      ? U extends object
        ? ComplexTransform<U>[]
        : T[K]
      : T[K] extends object
        ? T[K] extends Date
          ? string
          : ComplexTransform<T[K]>
        : T[K] extends number
          ? string
          : T[K]
}
// Multiple nested conditionals evaluated for every property
```

**Correct (composed utility types):**

```typescript
type TransformValue<T> = T extends Date
  ? string
  : T extends number
    ? string
    : T

type TransformObject<T> = {
  [K in keyof T]: TransformProperty<T[K]>
}

type TransformProperty<T> = T extends Function
  ? T
  : T extends Array<infer U>
    ? TransformArray<U>
    : T extends object
      ? TransformObject<T>
      : TransformValue<T>

type TransformArray<T> = T extends object
  ? TransformObject<T>[]
  : T[]

// Each utility is cached independently
type TransformedUser = TransformObject<User>
```

**Benefits:**
- Each small utility type is cached separately
- Easier to debug type errors
- More reusable across the codebase

**When complex mapped types are acceptable:**
- Internal utility types used in few places
- Types that genuinely require complex logic

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance)
