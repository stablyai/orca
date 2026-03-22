---
title: Use Promise.all for Independent Operations
impact: HIGH
impactDescription: 2-10× improvement in I/O-bound code
tags: async, promises, parallel, waterfalls, performance
---

## Use Promise.all for Independent Operations

Sequential `await` statements create request waterfalls—each operation waits for the previous one to complete. Use `Promise.all()` to execute independent async operations concurrently.

**Incorrect (sequential execution, N round trips):**

```typescript
async function loadDashboard(userId: string): Promise<Dashboard> {
  const user = await fetchUser(userId)           // 200ms
  const orders = await fetchOrders(userId)       // 300ms
  const notifications = await fetchNotifications(userId)  // 150ms
  // Total: 650ms (sequential)

  return { user, orders, notifications }
}
```

**Correct (parallel execution, wall-clock time = max latency):**

```typescript
async function loadDashboard(userId: string): Promise<Dashboard> {
  const [user, orders, notifications] = await Promise.all([
    fetchUser(userId),           // 200ms ─┐
    fetchOrders(userId),         // 300ms ─┼─ Run in parallel
    fetchNotifications(userId),  // 150ms ─┘
  ])
  // Total: 300ms (max of all operations)

  return { user, orders, notifications }
}
```

**For error handling with partial success:**

```typescript
async function loadDashboard(userId: string): Promise<Dashboard> {
  const results = await Promise.allSettled([
    fetchUser(userId),
    fetchOrders(userId),
    fetchNotifications(userId),
  ])

  return {
    user: results[0].status === 'fulfilled' ? results[0].value : null,
    orders: results[1].status === 'fulfilled' ? results[1].value : [],
    notifications: results[2].status === 'fulfilled' ? results[2].value : [],
  }
}
```

**When sequential is correct:**
- Operations have data dependencies (need result A to make request B)
- Rate limiting requires sequential requests
- Order of execution matters for side effects

Reference: [MDN Promise.all](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all)
