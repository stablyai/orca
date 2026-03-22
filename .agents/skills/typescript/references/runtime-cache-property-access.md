---
title: Cache Property Access in Loops
impact: LOW-MEDIUM
impactDescription: reduces property lookups by N× in hot paths
tags: runtime, loops, caching, property-access, optimization
---

## Cache Property Access in Loops

Cache deeply nested or polymorphic property access before hot loops. **Note:** Modern V8's inline caches optimize monomorphic access efficiently — this optimization is only meaningful for 10,000+ iterations with deeply nested or polymorphic properties.

**Incorrect (repeated nested access in hot loop):**

```typescript
function processOrders(orders: Order[], config: AppConfig): ProcessedOrder[] {
  const results: ProcessedOrder[] = []

  for (const order of orders) {
    const tax = order.total * config.tax.rate  // Nested access each iteration
    const shipping = config.shipping.rates[order.region]  // Nested access again
    results.push({ ...order, tax, shipping, final: order.total + tax + shipping })
  }

  return results
}
```

**Correct (cached property access):**

```typescript
function processOrders(orders: Order[], config: AppConfig): ProcessedOrder[] {
  const results: ProcessedOrder[] = []
  const taxRate = config.tax.rate
  const shippingRates = config.shipping.rates

  for (const order of orders) {
    const tax = order.total * taxRate
    const shipping = shippingRates[order.region]
    results.push({ ...order, tax, shipping, final: order.total + tax + shipping })
  }

  return results
}
```

**When V8 handles it automatically (no caching needed):**

```typescript
// Monomorphic — all objects have same shape, V8 ICs optimize this
function sumOrders(orders: Order[]): number {
  let total = 0
  for (let i = 0; i < orders.length; i++) {  // orders.length is fine
    total += orders[i].total  // Same shape every time
  }
  return total
}
```

**When to skip this optimization:**
- Arrays under 1,000 items
- Monomorphic objects (same shape/class)
- Non-hot paths executed infrequently
- When readability suffers significantly

Reference: [V8 Hidden Classes](https://v8.dev/blog/fast-properties)
