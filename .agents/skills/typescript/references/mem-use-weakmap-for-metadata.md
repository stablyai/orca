---
title: Use WeakMap for Object Metadata
impact: MEDIUM
impactDescription: prevents memory leaks, enables automatic cleanup
tags: mem, weakmap, metadata, garbage-collection, memory-leaks
---

## Use WeakMap for Object Metadata

WeakMap allows garbage collection of keys when no other references exist. Use it for associating metadata with objects without preventing their cleanup.

**Incorrect (Map retains object references):**

```typescript
const userMetadata = new Map<User, UserMetadata>()

function trackUser(user: User): void {
  userMetadata.set(user, {
    lastSeen: Date.now(),
    pageViews: 0
  })
}

function removeUser(user: User): void {
  // Even after user is "removed" from app state,
  // Map still holds reference, preventing GC
  userMetadata.delete(user)  // Must manually clean up
}

// If delete is forgotten, user objects leak forever
```

**Correct (WeakMap allows GC):**

```typescript
const userMetadata = new WeakMap<User, UserMetadata>()

function trackUser(user: User): void {
  userMetadata.set(user, {
    lastSeen: Date.now(),
    pageViews: 0
  })
}

// No cleanup needed - when user object is GC'd,
// WeakMap entry is automatically removed
function processUsers(users: User[]): void {
  for (const user of users) {
    trackUser(user)
  }
  // When users array is cleared, all metadata is cleaned up automatically
}
```

**Common use cases:**

```typescript
// DOM element metadata
const elementState = new WeakMap<HTMLElement, ElementState>()

function attachState(element: HTMLElement): void {
  elementState.set(element, { isExpanded: false })
  // When element is removed from DOM and GC'd, state is cleaned up
}

// Caching computed values
const computedCache = new WeakMap<Config, ComputedConfig>()

function getComputedConfig(config: Config): ComputedConfig {
  let computed = computedCache.get(config)
  if (!computed) {
    computed = expensiveComputation(config)
    computedCache.set(config, computed)
  }
  return computed
}
```

**Limitations of WeakMap:**
- Keys must be objects (not primitives)
- Not iterable (no `.keys()`, `.values()`, `.entries()`)
- No `.size` property

Reference: [MDN WeakMap](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap)
