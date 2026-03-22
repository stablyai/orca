---
title: Clean Up Event Listeners
impact: MEDIUM
impactDescription: prevents unbounded memory growth
tags: mem, event-listeners, cleanup, memory-leaks, lifecycle
---

## Clean Up Event Listeners

Event listeners hold references to their callback functions and bound objects. Failing to remove them when components unmount causes memory to grow with each mount/unmount cycle.

**Incorrect (listeners never removed):**

```typescript
class WebSocketManager {
  private socket: WebSocket

  connect(url: string): void {
    this.socket = new WebSocket(url)

    this.socket.addEventListener('message', (event) => {
      this.handleMessage(event.data)
    })

    this.socket.addEventListener('error', (event) => {
      this.handleError(event)
    })
    // Listeners keep 'this' alive even after disconnect
  }

  disconnect(): void {
    this.socket.close()
    // Listeners still attached, WebSocketManager can't be GC'd
  }
}
```

**Correct (listeners removed on cleanup):**

```typescript
class WebSocketManager {
  private socket: WebSocket
  private messageHandler: (event: MessageEvent) => void
  private errorHandler: (event: Event) => void

  connect(url: string): void {
    this.socket = new WebSocket(url)

    this.messageHandler = (event) => this.handleMessage(event.data)
    this.errorHandler = (event) => this.handleError(event)

    this.socket.addEventListener('message', this.messageHandler)
    this.socket.addEventListener('error', this.errorHandler)
  }

  disconnect(): void {
    this.socket.removeEventListener('message', this.messageHandler)
    this.socket.removeEventListener('error', this.errorHandler)
    this.socket.close()
  }
}
```

**Using AbortController (modern pattern):**

```typescript
class WebSocketManager {
  private socket: WebSocket
  private abortController: AbortController

  connect(url: string): void {
    this.abortController = new AbortController()
    const { signal } = this.abortController

    this.socket = new WebSocket(url)

    this.socket.addEventListener('message', (e) => this.handleMessage(e.data), { signal })
    this.socket.addEventListener('error', (e) => this.handleError(e), { signal })
    // All listeners automatically removed when signal is aborted
  }

  disconnect(): void {
    this.abortController.abort()  // Removes all listeners at once
    this.socket.close()
  }
}
```

**React useEffect pattern:**

```typescript
function useWebSocket(url: string): Data | null {
  const [data, setData] = useState<Data | null>(null)

  useEffect(() => {
    const socket = new WebSocket(url)
    const handler = (event: MessageEvent) => setData(JSON.parse(event.data))

    socket.addEventListener('message', handler)

    return () => {
      socket.removeEventListener('message', handler)
      socket.close()
    }
  }, [url])

  return data
}
```

Reference: [MDN AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
