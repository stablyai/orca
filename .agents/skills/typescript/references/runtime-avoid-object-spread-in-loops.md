---
title: Avoid Object Spread in Hot Loops
impact: LOW-MEDIUM
impactDescription: reduces object allocations by N×
tags: runtime, object-spread, loops, allocation, performance
---

## Avoid Object Spread in Hot Loops

Object spread (`...`) creates a new object on each use. In loops, this causes N object allocations and copies. Mutate objects directly when creating new instances isn't required.

**Incorrect (N object allocations):**

```typescript
function enrichOrders(orders: Order[]): EnrichedOrder[] {
  return orders.map(order => ({
    ...order,  // Creates new object
    ...calculateTotals(order),  // Spreads another object
    processedAt: new Date()
  }))
}
// 10,000 orders = 10,000 object spreads = significant GC pressure
```

**Correct (direct assignment):**

```typescript
interface EnrichedOrder extends Order {
  tax: number
  shipping: number
  total: number
  processedAt: Date
}

function enrichOrders(orders: Order[]): EnrichedOrder[] {
  return orders.map(order => {
    const totals = calculateTotals(order)

    return {
      id: order.id,
      customerId: order.customerId,
      items: order.items,
      subtotal: order.subtotal,
      tax: totals.tax,
      shipping: totals.shipping,
      total: totals.total,
      processedAt: new Date()
    }
  })
}
```

**Note:** For immutable object creation, explicit property listing is the only spread-free option. This trades verbosity for performance in hot paths. If immutability isn't required, mutating the original object is faster still.

**For accumulation patterns:**

```typescript
// Incorrect - spreads on every iteration
const result = items.reduce((acc, item) => ({
  ...acc,
  [item.id]: item.value
}), {})
// O(n²) - each spread copies growing object

// Correct - mutate accumulator
const result = items.reduce((acc, item) => {
  acc[item.id] = item.value
  return acc
}, {} as Record<string, number>)
// O(n) - direct property assignment
```

**When spread is acceptable:**
- Outside hot paths
- Small objects (< 10 properties)
- When immutability is required for state management
- When readability significantly improves

Reference: [V8 Object Shapes](https://mathiasbynens.be/notes/shapes-ics)
