---
title: Use erasableSyntaxOnly for Node.js Native TypeScript
impact: HIGH
impactDescription: prevents 100% of Node.js type-stripping runtime errors
tags: tscfg, erasableSyntaxOnly, node, type-stripping, enums
---

## Use erasableSyntaxOnly for Node.js Native TypeScript

The `erasableSyntaxOnly` flag (TypeScript 5.8+) ensures your code only uses TypeScript syntax that can be removed by erasing type annotations — no code generation required. This is mandatory for Node.js `--experimental-strip-types` which strips types but cannot transform enums, namespaces, or parameter properties.

**Incorrect (non-erasable syntax fails with Node.js type-stripping):**

```json
{
  "compilerOptions": {
    "erasableSyntaxOnly": true
  }
}
```

```typescript
// Error: non-erasable syntax
export enum OrderStatus {
  Pending = 'pending',
  Shipped = 'shipped',
  Delivered = 'delivered'
}

// Error: non-erasable syntax
namespace Validation {
  export function isValid(input: string): boolean {
    return input.length > 0
  }
}

// Error: non-erasable parameter property
class UserService {
  constructor(private readonly repository: UserRepository) {}
}
```

**Correct (erasable alternatives):**

```typescript
// Union type instead of enum
export type OrderStatus = 'pending' | 'shipped' | 'delivered'

// Object constant for runtime values
export const OrderStatus = {
  Pending: 'pending',
  Shipped: 'shipped',
  Delivered: 'delivered',
} as const satisfies Record<string, OrderStatus>

// Module-level functions instead of namespace
export function isValid(input: string): boolean {
  return input.length > 0
}

// Explicit property assignment instead of parameter property
class UserService {
  readonly repository: UserRepository
  constructor(repository: UserRepository) {
    this.repository = repository
  }
}
```

**Recommended configuration for Node.js native TS:**

```json
{
  "compilerOptions": {
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  }
}
```

**When NOT to use this flag:**
- Projects using a bundler (esbuild, swc, Vite) that supports enum transformation
- Libraries that need to support both bundled and unbundled consumers
- Codebases with extensive enum usage where migration cost is high

Reference: [TypeScript 5.8 - erasableSyntaxOnly](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html)
