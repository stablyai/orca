---
title: Use const Assertions for Literal Types
impact: MEDIUM-HIGH
impactDescription: preserves literal types, enables better inference
tags: safety, const-assertion, literals, inference, readonly
---

## Use const Assertions for Literal Types

The `as const` assertion preserves literal types and makes arrays/objects readonly. This enables precise type inference and prevents accidental mutations.

**Incorrect (widened types):**

```typescript
const config = {
  apiUrl: 'https://api.example.com',
  retries: 3,
  methods: ['GET', 'POST']
}
// Type: { apiUrl: string; retries: number; methods: string[] }

function makeRequest(method: 'GET' | 'POST'): void { }

makeRequest(config.methods[0])
// Error: Argument of type 'string' is not assignable to 'GET' | 'POST'

const STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active'
}
// Type: { PENDING: string; ACTIVE: string }
```

**Correct (const assertion preserves literals):**

```typescript
const config = {
  apiUrl: 'https://api.example.com',
  retries: 3,
  methods: ['GET', 'POST']
} as const
// Type: { readonly apiUrl: 'https://api.example.com'; readonly retries: 3; readonly methods: readonly ['GET', 'POST'] }

function makeRequest(method: 'GET' | 'POST'): void { }

makeRequest(config.methods[0])  // Works: 'GET' is assignable to 'GET' | 'POST'

const STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active'
} as const
// Type: { readonly PENDING: 'pending'; readonly ACTIVE: 'active' }

type StatusType = typeof STATUS[keyof typeof STATUS]  // 'pending' | 'active'
```

**For function parameters:**

```typescript
// Incorrect - tuple becomes array
function setCoordinates(coords: [number, number]): void { }
setCoordinates([10, 20])  // Error: number[] not assignable to [number, number]

// Correct - const preserves tuple
setCoordinates([10, 20] as const)  // Works

// Or inline
function setCoordinates(coords: readonly [number, number]): void { }
```

**When to use const assertions:**
- Configuration objects that shouldn't change
- Enum-like objects with string values
- Array/tuple literals passed to functions expecting specific types
- Creating type-safe lookup tables

Reference: [TypeScript 3.4 Const Assertions](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html#const-assertions)
