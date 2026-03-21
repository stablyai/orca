# Better Alternatives to useEffect

## 1. Calculate During Render (Derived State)

For values derived from props or state, just compute them:

```tsx
function Form() {
  const [firstName, setFirstName] = useState('Taylor')
  const [lastName, setLastName] = useState('Swift')

  // Runs every render - that's fine and intentional
  const fullName = firstName + ' ' + lastName
  const isValid = firstName.length > 0 && lastName.length > 0
}
```

**When to use**: The value can be computed from existing props/state.

---

## 2. useMemo for Expensive Calculations

When computation is expensive, memoize it:

```tsx
import { useMemo } from 'react'

function TodoList({ todos, filter }) {
  const visibleTodos = useMemo(() => getFilteredTodos(todos, filter), [todos, filter])
}
```

**How to know if it's expensive**:

```tsx
console.time('filter')
const visibleTodos = getFilteredTodos(todos, filter)
console.timeEnd('filter')
// If > 1ms, consider memoizing
```

**Note**: React Compiler can auto-memoize, reducing manual useMemo needs.

---

## 3. Key Prop to Reset State

To reset ALL state when a prop changes, use key:

```tsx
// Parent passes userId as key
function ProfilePage({ userId }) {
  return (
    <Profile
      userId={userId}
      key={userId} // Different userId = different component instance
    />
  )
}

function Profile({ userId }) {
  // All state here resets when userId changes
  const [comment, setComment] = useState('')
  const [likes, setLikes] = useState([])
}
```

**When to use**: You want a "fresh start" when an identity prop changes.

---

## 4. Store ID Instead of Object

To preserve selection when list changes:

```tsx
// BAD: Storing object that needs Effect to "adjust"
function List({ items }) {
  const [selection, setSelection] = useState(null)

  useEffect(() => {
    setSelection(null) // Reset when items change
  }, [items])
}

// GOOD: Store ID, derive object
function List({ items }) {
  const [selectedId, setSelectedId] = useState(null)

  // Derived - no Effect needed
  const selection = items.find((item) => item.id === selectedId) ?? null
}
```

**Benefit**: If item with selectedId exists in new list, selection preserved.

---

## 5. Event Handlers for User Actions

User clicks/submits/drags should be handled in event handlers, not Effects:

```tsx
// Event handler knows exactly what happened
function ProductPage({ product, addToCart }) {
  function handleBuyClick() {
    addToCart(product)
    showNotification(`Added ${product.name}!`)
    analytics.track('product_added', { id: product.id })
  }

  function handleCheckoutClick() {
    addToCart(product)
    showNotification(`Added ${product.name}!`)
    navigateTo('/checkout')
  }
}
```

**Shared logic**: Extract a function, call from both handlers:

```tsx
function buyProduct() {
  addToCart(product)
  showNotification(`Added ${product.name}!`)
}

function handleBuyClick() {
  buyProduct()
}
function handleCheckoutClick() {
  buyProduct()
  navigateTo('/checkout')
}
```

---

## 6. useSyncExternalStore for External Stores

For subscribing to external data (browser APIs, third-party stores):

```tsx
// Instead of manual Effect subscription
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(true)

  useEffect(() => {
    function update() {
      setIsOnline(navigator.onLine)
    }
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  return isOnline
}

// Use purpose-built hook
import { useSyncExternalStore } from 'react'

function subscribe(callback) {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}

function useOnlineStatus() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine, // Client value
    () => true // Server value (SSR)
  )
}
```

---

## 7. Lifting State Up

When two components need synchronized state, lift it to common ancestor:

```tsx
// Instead of syncing via Effects between siblings
function Parent() {
  const [value, setValue] = useState('')

  return (
    <>
      <Input value={value} onChange={setValue} />
      <Preview value={value} />
    </>
  )
}
```

---

## 8. Custom Hooks for Data Fetching

Extract fetch logic with proper cleanup:

```tsx
function useData(url) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let ignore = false
    setLoading(true)

    fetch(url)
      .then((res) => res.json())
      .then((json) => {
        if (!ignore) {
          setData(json)
          setError(null)
        }
      })
      .catch((err) => {
        if (!ignore) setError(err)
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })

    return () => {
      ignore = true
    }
  }, [url])

  return { data, error, loading }
}

// Usage
function SearchResults({ query }) {
  const { data, error, loading } = useData(`/api/search?q=${query}`)
}
```

**Better**: Use framework's data fetching (React Query, SWR, Next.js, etc.)

---

## Summary: When to Use What

| Need                           | Solution                             |
| ------------------------------ | ------------------------------------ |
| Value from props/state         | Calculate during render              |
| Expensive calculation          | `useMemo`                            |
| Reset all state on prop change | `key` prop                           |
| Respond to user action         | Event handler                        |
| Sync with external system      | `useEffect` with cleanup             |
| Subscribe to external store    | `useSyncExternalStore`               |
| Share state between components | Lift state up                        |
| Fetch data                     | Custom hook with cleanup / framework |
