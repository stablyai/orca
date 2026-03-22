---
title: Avoid Closure Memory Leaks
impact: MEDIUM
impactDescription: prevents retained references in long-lived callbacks
tags: mem, closures, memory-leaks, callbacks, garbage-collection
---

## Avoid Closure Memory Leaks

Closures retain references to their outer scope variables. Long-lived callbacks can accidentally keep large objects alive, causing memory to grow unboundedly.

**Incorrect (closure retains entire scope):**

```typescript
function createDataProcessor(largeDataset: DataRecord[]): () => void {
  const processedIds = new Set<string>()

  return function processNext(): void {
    // This closure retains reference to largeDataset
    // even though it only needs processedIds
    const next = largeDataset.find(r => !processedIds.has(r.id))
    if (next) {
      processedIds.add(next.id)
      sendToServer(next)
    }
  }
}

// largeDataset (100MB) stays in memory as long as processNext exists
const processor = createDataProcessor(hugeDataset)
setInterval(processor, 1000)  // Runs forever, 100MB never freed
```

**Correct (closure captures only what it needs):**

```typescript
function createDataProcessor(largeDataset: DataRecord[]): () => void {
  // Build a queue of just the IDs and a lookup for individual records
  const pendingQueue: string[] = largeDataset.map(r => r.id)
  const getRecord = (id: string): DataRecord | undefined =>
    largeDataset.find(r => r.id === id)

  // Release the array reference — closure only captures pendingQueue and getRecord
  // Caller should also release their reference to largeDataset
  return function processNext(): void {
    const nextId = pendingQueue.shift()
    if (nextId) {
      const record = getRecord(nextId)
      if (record) sendToServer(record)
    }
  }
}
```

**Better pattern — accept an iterator to avoid holding the full dataset:**

```typescript
function createDataProcessor(records: Iterable<DataRecord>): () => void {
  const iterator = records[Symbol.iterator]()

  return function processNext(): void {
    const { value, done } = iterator.next()
    if (!done) {
      sendToServer(value)
    }
  }
}
```

**For event handlers:**

```typescript
// Incorrect - handler retains component instance forever
class Dashboard {
  private largeCache: Map<string, Data> = new Map()

  initialize(): void {
    window.addEventListener('resize', () => {
      this.handleResize()  // 'this' keeps entire Dashboard alive
    })
  }
}

// Correct - remove listener when done
class Dashboard {
  private largeCache: Map<string, Data> = new Map()
  private resizeHandler: () => void

  initialize(): void {
    this.resizeHandler = () => this.handleResize()
    window.addEventListener('resize', this.resizeHandler)
  }

  destroy(): void {
    window.removeEventListener('resize', this.resizeHandler)
    this.largeCache.clear()
  }
}
```

Reference: [Node.js Memory Diagnostics](https://nodejs.org/en/learn/diagnostics/memory)
