---
title: Annotate Async Function Return Types
impact: HIGH
impactDescription: prevents runtime errors, improves inference
tags: async, return-types, promises, type-safety, inference
---

## Annotate Async Function Return Types

Explicit return types on async functions catch mismatches at the function boundary rather than at call sites. They also improve IDE performance by avoiding full function body inference.

**Incorrect (inferred Promise type):**

```typescript
async function fetchUserOrders(userId: string) {
  const response = await fetch(`/api/users/${userId}/orders`)
  if (!response.ok) {
    return null  // Implicit: Promise<Order[] | null>
  }
  return response.json()  // Implicit: Promise<any>
}

// Caller has unclear type: Promise<any>
const orders = await fetchUserOrders('123')
orders.map(o => o.id)  // No type error even if orders is null
```

**Correct (explicit Promise type):**

```typescript
interface Order {
  id: string
  total: number
  status: OrderStatus
}

async function fetchUserOrders(userId: string): Promise<Order[] | null> {
  const response = await fetch(`/api/users/${userId}/orders`)
  if (!response.ok) {
    return null
  }
  return response.json() as Promise<Order[]>
}

// Caller knows the exact type
const orders = await fetchUserOrders('123')
if (orders) {
  orders.map(o => o.id)  // Type-safe access
}
```

**For functions that might throw:**

```typescript
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

async function fetchUserOrders(userId: string): Promise<Result<Order[]>> {
  try {
    const response = await fetch(`/api/users/${userId}/orders`)
    if (!response.ok) {
      return { ok: false, error: new Error(`HTTP ${response.status}`) }
    }
    const orders = await response.json() as Order[]
    return { ok: true, value: orders }
  } catch (error) {
    return { ok: false, error: error as Error }
  }
}
```

**Benefits:**
- Errors caught at function definition, not call sites
- Better IDE autocomplete for consumers
- Self-documenting API contracts

Reference: [TypeScript Performance Wiki - Using Type Annotations](https://github.com/microsoft/TypeScript/wiki/Performance#using-type-annotations)
