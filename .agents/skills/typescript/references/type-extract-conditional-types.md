---
title: Extract Conditional Types to Named Aliases
impact: CRITICAL
impactDescription: enables compiler caching, prevents re-evaluation
tags: type, conditional-types, generics, caching, performance
---

## Extract Conditional Types to Named Aliases

Inline conditional types are re-evaluated on every function call. Extracting them to named type aliases allows the compiler to cache results and reuse them across multiple call sites.

**Incorrect (inline conditional, re-evaluated each call):**

```typescript
function processResponse<T>(
  response: T
): T extends { data: infer D }
   ? D extends Array<infer Item>
     ? Item[]
     : D
   : never {
  // Compiler re-computes this complex conditional on every call
  return response.data
}

function getFirstItem<T>(collection: T): T extends Array<infer U> ? U : T {
  // Re-evaluated for each getFirstItem() usage
}
```

**Correct (extracted, cacheable):**

```typescript
type ExtractData<T> = T extends { data: infer D }
  ? D extends Array<infer Item>
    ? Item[]
    : D
  : never

function processResponse<T>(response: T): ExtractData<T> {
  // Compiler caches ExtractData<T> resolution
  return response.data
}

type UnwrapArray<T> = T extends Array<infer U> ? U : T

function getFirstItem<T>(collection: T): UnwrapArray<T> {
  // Reuses cached UnwrapArray<T> computation
}
```

**Benefits:**
- Type alias acts as a cache boundary
- Reduces duplicate computation across multiple call sites
- Improves IDE responsiveness for autocomplete

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#using-type-aliases)
