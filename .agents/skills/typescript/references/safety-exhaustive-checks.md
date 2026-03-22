---
title: Use Exhaustive Checks for Union Types
impact: MEDIUM-HIGH
impactDescription: prevents 100% of missing case errors at compile time
tags: safety, exhaustive, never, discriminated-unions, switch
---

## Use Exhaustive Checks for Union Types

Exhaustive checks ensure all union members are handled. When a new member is added, TypeScript errors on unhandled cases rather than falling through silently at runtime.

**Incorrect (missing case compiles but fails at runtime):**

```typescript
type OrderStatus = 'pending' | 'processing' | 'shipped' | 'delivered'

function getStatusMessage(status: OrderStatus): string {
  switch (status) {
    case 'pending':
      return 'Order received'
    case 'processing':
      return 'Preparing your order'
    case 'shipped':
      return 'On the way'
    // 'delivered' case missing - no compile error
    // Returns undefined at runtime
  }
}

// Later, someone adds 'cancelled' to OrderStatus
// This function silently returns undefined for 'cancelled' and 'delivered'
```

**Correct (exhaustive check with never):**

```typescript
type OrderStatus = 'pending' | 'processing' | 'shipped' | 'delivered'

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${value}`)
}

function getStatusMessage(status: OrderStatus): string {
  switch (status) {
    case 'pending':
      return 'Order received'
    case 'processing':
      return 'Preparing your order'
    case 'shipped':
      return 'On the way'
    case 'delivered':
      return 'Order complete'
    default:
      return assertNever(status)  // Compile error if case missed
  }
}

// Adding 'cancelled' to OrderStatus now causes compile error:
// Argument of type 'string' is not assignable to parameter of type 'never'
```

**For object mapping (alternative pattern):**

```typescript
const statusMessages: Record<OrderStatus, string> = {
  pending: 'Order received',
  processing: 'Preparing your order',
  shipped: 'On the way',
  delivered: 'Order complete',
  // Missing key causes: Property 'cancelled' is missing in type
}

function getStatusMessage(status: OrderStatus): string {
  return statusMessages[status]
}
```

**Benefits:**
- Compile-time error when union expands
- Self-documenting: all cases explicitly handled
- Runtime safety via assertNever fallback

Reference: [TypeScript Handbook - Exhaustiveness Checking](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking)
