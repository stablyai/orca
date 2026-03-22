---
title: Avoid Circular Dependencies
impact: HIGH
impactDescription: prevents runtime undefined errors and slow compilation
tags: module, circular, dependencies, architecture, compilation
---

## Avoid Circular Dependencies

Circular dependencies cause undefined values at runtime (due to incomplete module initialization) and slow TypeScript compilation as the checker resolves cycles repeatedly.

**Incorrect (circular dependency):**

```typescript
// user.ts
import { Order } from './order'

export interface User {
  id: string
  orders: Order[]
}

export function createUser(): User { /* ... */ }

// order.ts
import { User } from './user'  // Circular!

export interface Order {
  id: string
  user: User
}

export function createOrder(user: User): Order {
  // 'createUser' might be undefined if order.ts loads first
}
```

**Correct (extract shared types):**

```typescript
// types.ts (no dependencies)
export interface User {
  id: string
  orders: Order[]
}

export interface Order {
  id: string
  user: User
}

// user.ts
import { User, Order } from './types'

export function createUser(): User { /* ... */ }

// order.ts
import { User, Order } from './types'

export function createOrder(user: User): Order { /* ... */ }
```

**Alternative (interface segregation):**

```typescript
// user-types.ts
export interface UserBase {
  id: string
  name: string
}

// order.ts
import { UserBase } from './user-types'

export interface Order {
  id: string
  user: UserBase  // Only needs base interface, not full User
}
```

**Detection tools:**

```bash
# Madge - visualize circular dependencies
npx madge --circular --extensions ts ./src

# ESLint plugin
npm install eslint-plugin-import
# Rule: import/no-cycle
```

Reference: [Node.js Cycles Documentation](https://nodejs.org/api/modules.html#cycles)
