---
title: Use Assertion Functions for Validation
impact: MEDIUM-HIGH
impactDescription: reduces validation boilerplate by 50-70%
tags: safety, assertion-functions, asserts, validation, narrowing
---

## Use Assertion Functions for Validation

Assertion functions (`asserts` return type) tell TypeScript that if the function returns, the condition is true. This narrows types in the calling scope without explicit if-checks.

**Incorrect (repeated if-throw pattern):**

```typescript
function processOrder(order: Order | null): void {
  if (!order) {
    throw new Error('Order is required')
  }
  if (order.status !== 'pending') {
    throw new Error('Order must be pending')
  }
  if (!order.items.length) {
    throw new Error('Order must have items')
  }

  // Finally can use order safely
  submitOrder(order)
}

// Same checks repeated in every function that needs a valid order
function shipOrder(order: Order | null): void {
  if (!order) throw new Error('Order is required')
  if (order.status !== 'pending') throw new Error('Order must be pending')
  // ...duplicate validation
}
```

**Correct (assertion function):**

```typescript
interface ValidOrder extends Order {
  status: 'pending'
  items: [OrderItem, ...OrderItem[]]  // Non-empty array
}

function assertValidOrder(order: Order | null): asserts order is ValidOrder {
  if (!order) {
    throw new Error('Order is required')
  }
  if (order.status !== 'pending') {
    throw new Error('Order must be pending')
  }
  if (!order.items.length) {
    throw new Error('Order must have items')
  }
}

function processOrder(order: Order | null): void {
  assertValidOrder(order)
  // order is now typed as ValidOrder
  submitOrder(order)  // Type-safe
}

function shipOrder(order: Order | null): void {
  assertValidOrder(order)
  // Reuses validation, order is ValidOrder
  ship(order)
}
```

**For generic assertions:**

```typescript
function assertDefined<T>(value: T | null | undefined, name: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(`${name} must be defined`)
  }
}

function processUser(user: User | null): void {
  assertDefined(user, 'user')
  // user is now User, not User | null
  console.log(user.email)
}
```

**Benefits:**
- Centralizes validation logic
- Automatic type narrowing after assertion
- Clearer intent than if-throw patterns

Reference: [TypeScript 3.7 Assertion Functions](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#assertion-functions)
