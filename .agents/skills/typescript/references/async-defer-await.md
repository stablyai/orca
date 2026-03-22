---
title: Defer await Until Value Is Needed
impact: HIGH
impactDescription: enables implicit parallelization
tags: async, defer, promises, optimization, performance
---

## Defer await Until Value Is Needed

Start async operations immediately but defer `await` until the value is actually required. This allows independent work to proceed while promises resolve in the background.

**Incorrect (blocks immediately, serializes independent work):**

```typescript
async function processOrder(orderId: string): Promise<OrderResult> {
  const order = await fetchOrder(orderId)  // Blocks here
  const config = await loadProcessingConfig()  // Waits for order first, unnecessarily

  // config doesn't depend on order — these could run in parallel
  if (order.priority === 'express') {
    return processExpress(order, config)
  }
  return processStandard(order, config)
}
```

**Correct (deferred await):**

```typescript
async function processOrder(orderId: string): Promise<OrderResult> {
  const orderPromise = fetchOrder(orderId)  // Start immediately
  const config = await loadProcessingConfig()  // Runs while order fetches

  const order = await orderPromise  // Now await when needed

  if (order.priority === 'express') {
    return processExpress(order, config)
  }
  return processStandard(order, config)
}
```

**Pattern for dependent-then-independent operations:**

```typescript
async function loadUserContent(userId: string): Promise<Content> {
  // Start user fetch (needed for dependent calls)
  const userPromise = fetchUser(userId)

  // Start independent operations immediately
  const settingsPromise = fetchGlobalSettings()
  const featuresPromise = fetchFeatureFlags()

  // Await user for dependent operations
  const user = await userPromise
  const ordersPromise = fetchOrders(user.id)
  const prefsPromise = fetchPreferences(user.id)

  // Await all remaining
  const [settings, features, orders, prefs] = await Promise.all([
    settingsPromise,
    featuresPromise,
    ordersPromise,
    prefsPromise,
  ])

  return { user, settings, features, orders, prefs }
}
```

Reference: [V8 Blog - Fast Async](https://v8.dev/blog/fast-async)
