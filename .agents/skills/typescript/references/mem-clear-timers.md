---
title: Clear Timers and Intervals
impact: MEDIUM
impactDescription: prevents callback retention and repeated execution
tags: mem, timers, intervals, cleanup, memory-leaks
---

## Clear Timers and Intervals

`setInterval` and `setTimeout` callbacks retain references to their closure scope. Failing to clear them causes callbacks to execute indefinitely and prevents garbage collection of referenced objects.

**Incorrect (intervals never cleared):**

```typescript
class DataPoller {
  private data: LargeDataset

  start(): void {
    setInterval(() => {
      this.data = fetchLatestData()
      this.updateDashboard()
    }, 5000)
    // No reference to interval ID, can't clear it
  }

  stop(): void {
    // Can't stop the interval - it runs forever
    // 'this' is retained, DataPoller can't be GC'd
  }
}

// Each new DataPoller instance creates another interval
// Old instances can't be cleaned up
```

**Correct (intervals tracked and cleared):**

```typescript
class DataPoller {
  private data: LargeDataset
  private intervalId: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.intervalId) return  // Prevent duplicate intervals

    this.intervalId = setInterval(() => {
      this.data = fetchLatestData()
      this.updateDashboard()
    }, 5000)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }
}
```

**For multiple timers:**

```typescript
class AnimationController {
  private timers = new Set<ReturnType<typeof setTimeout>>()

  scheduleAnimation(delay: number, callback: () => void): void {
    const timerId = setTimeout(() => {
      this.timers.delete(timerId)
      callback()
    }, delay)
    this.timers.add(timerId)
  }

  cancelAll(): void {
    for (const timerId of this.timers) {
      clearTimeout(timerId)
    }
    this.timers.clear()
  }
}
```

**React hook pattern:**

```typescript
function usePolling(callback: () => void, interval: number): void {
  useEffect(() => {
    const id = setInterval(callback, interval)
    return () => clearInterval(id)  // Cleanup on unmount
  }, [callback, interval])
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(timer)  // Clear on value change or unmount
  }, [value, delay])

  return debouncedValue
}
```

Reference: [MDN clearInterval](https://developer.mozilla.org/en-US/docs/Web/API/clearInterval)
