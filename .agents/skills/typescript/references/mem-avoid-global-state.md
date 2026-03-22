---
title: Avoid Global State Accumulation
impact: MEDIUM
impactDescription: prevents unbounded memory growth
tags: mem, global-state, singletons, memory-leaks, caching
---

## Avoid Global State Accumulation

Global variables and module-level state persist for the application's lifetime. Unbounded caches or collections at module scope grow indefinitely, causing memory exhaustion.

**Incorrect (unbounded global cache):**

```typescript
// cache.ts
const userCache = new Map<string, User>()  // Never cleared

export function getCachedUser(id: string): User | undefined {
  return userCache.get(id)
}

export function cacheUser(user: User): void {
  userCache.set(user.id, user)
  // Cache grows forever, never evicts old entries
}

// After 1 million users, cache holds 1 million User objects
```

**Correct (bounded cache with eviction):**

```typescript
// cache.ts
class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first) entry
      const oldest = this.cache.keys().next().value
      this.cache.delete(oldest)
    }
    this.cache.set(key, value)
  }
}

const userCache = new LRUCache<string, User>(1000)  // Max 1000 entries

export function getCachedUser(id: string): User | undefined {
  return userCache.get(id)
}

export function cacheUser(user: User): void {
  userCache.set(user.id, user)
}
```

**For request-scoped state (Node.js):**

```typescript
import { AsyncLocalStorage } from 'async_hooks'

interface RequestContext {
  userId: string
  cache: Map<string, unknown>
}

const requestContext = new AsyncLocalStorage<RequestContext>()

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn)
  // Context is automatically cleaned up when request ends
}

export function getRequestCache(): Map<string, unknown> {
  return requestContext.getStore()?.cache ?? new Map()
}
```

Reference: [Node.js Memory Management](https://nodejs.org/en/learn/diagnostics/memory)
