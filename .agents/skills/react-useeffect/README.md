# React useEffect Best Practices

A comprehensive guide teaching when to use `useEffect` in React, and more importantly, when NOT to use it. This skill is based on official React documentation and provides practical alternatives to common useEffect anti-patterns.

## Purpose

Effects are an **escape hatch** from React's reactive paradigm. They let you synchronize with external systems like browser APIs, third-party widgets, or network requests. However, many developers overuse Effects for tasks that React handles better through other means.

This skill helps you:

- Identify when you truly need an Effect vs. when you don't
- Recognize common anti-patterns and their fixes
- Apply better alternatives like `useMemo`, `key` prop, and event handlers
- Write Effects that are clean, maintainable, and free from race conditions

## When to Use This Skill

Use this skill when you're:

- Writing or reviewing `useEffect` code
- Using `useState` to store derived values
- Implementing data fetching or subscriptions
- Synchronizing state between components
- Facing bugs with stale data or race conditions
- Wondering if your Effect is necessary

**Trigger phrases:**

- "Should I use useEffect for this?"
- "How do I fix this useEffect?"
- "My Effect is causing too many re-renders"
- "Data fetching with useEffect"
- "Reset state when props change"
- "Derived state from props"

## How It Works

This skill provides guidance through three key resources:

1. **Quick Reference Table** - Fast lookup for common scenarios with DO/DON'T patterns
2. **Decision Tree** - Visual flowchart to determine the right approach
3. **Detailed Anti-Patterns** - 9 common mistakes with explanations and fixes
4. **Better Alternatives** - 8 proven patterns to replace unnecessary Effects

The skill teaches you to ask the right questions:

- Is there an external system involved?
- Am I responding to a user event or component appearance?
- Can this value be calculated during render?
- Do I need to reset state when a prop changes?

## Key Features

### 1. Quick Reference Guide

Visual table showing the DO/DON'T for common scenarios:

- Derived state from props/state
- Expensive calculations
- Resetting state on prop change
- User event responses
- Notifying parent components
- Data fetching

### 2. Decision Tree

Clear flowchart that guides you from "Need to respond to something?" to the correct solution:

- User interaction → Event handler
- Component appeared → Effect (for external sync/analytics)
- Derived value needed → Calculate during render (+ useMemo if expensive)
- Reset state on prop change → Key prop

### 3. Anti-Pattern Recognition

Detailed examples of 9 common mistakes:

1. Redundant state for derived values
2. Filtering/transforming data in Effect
3. Resetting state on prop change
4. Event-specific logic in Effect
5. Chains of Effects
6. Notifying parent via Effect
7. Passing data up to parent
8. Fetching without cleanup (race conditions)
9. App initialization in Effect

Each anti-pattern includes:

- Bad example with explanation
- Good example with fix
- Why the anti-pattern is problematic

### 4. Better Alternatives

8 proven patterns to replace unnecessary Effects:

1. Calculate during render for derived state
2. `useMemo` for expensive calculations
3. `key` prop to reset state
4. Store ID instead of object for stable references
5. Event handlers for user actions
6. `useSyncExternalStore` for external stores
7. Lifting state up for shared state
8. Custom hooks for data fetching with cleanup

## Usage Examples

### Example 1: Derived State

**Bad - Unnecessary Effect:**

```tsx
function Form() {
  const [firstName, setFirstName] = useState('Taylor')
  const [lastName, setLastName] = useState('Swift')
  const [fullName, setFullName] = useState('')

  useEffect(() => {
    setFullName(firstName + ' ' + lastName)
  }, [firstName, lastName])
}
```

**Good - Calculate during render:**

```tsx
function Form() {
  const [firstName, setFirstName] = useState('Taylor')
  const [lastName, setLastName] = useState('Swift')
  const fullName = firstName + ' ' + lastName // Just compute it
}
```

### Example 2: Resetting State

**Bad - Effect to reset:**

```tsx
function ProfilePage({ userId }) {
  const [comment, setComment] = useState('')

  useEffect(() => {
    setComment('')
  }, [userId])
}
```

**Good - Key prop:**

```tsx
function ProfilePage({ userId }) {
  return <Profile userId={userId} key={userId} />
}

function Profile({ userId }) {
  const [comment, setComment] = useState('') // Resets automatically
}
```

### Example 3: Data Fetching with Cleanup

**Bad - Race condition:**

```tsx
function SearchResults({ query }) {
  const [results, setResults] = useState([])

  useEffect(() => {
    fetchResults(query).then((json) => {
      setResults(json) // "hello" response may arrive after "hell"
    })
  }, [query])
}
```

**Good - Cleanup flag:**

```tsx
function SearchResults({ query }) {
  const [results, setResults] = useState([])

  useEffect(() => {
    let ignore = false

    fetchResults(query).then((json) => {
      if (!ignore) setResults(json)
    })

    return () => {
      ignore = true
    }
  }, [query])
}
```

### Example 4: Event Handler Instead of Effect

**Bad - Effect watching state:**

```tsx
function ProductPage({ product, addToCart }) {
  useEffect(() => {
    if (product.isInCart) {
      showNotification(`Added ${product.name}!`)
    }
  }, [product])

  function handleBuyClick() {
    addToCart(product)
  }
}
```

**Good - Handle in event:**

```tsx
function ProductPage({ product, addToCart }) {
  function handleBuyClick() {
    addToCart(product)
    showNotification(`Added ${product.name}!`)
  }
}
```

## When You DO Need Effects

Effects are appropriate for:

- **Synchronizing with external systems** - Browser APIs, third-party widgets, non-React code
- **Subscriptions** - WebSocket connections, global event listeners (prefer `useSyncExternalStore`)
- **Analytics/logging** - Code that needs to run because the component displayed
- **Data fetching** - With proper cleanup (or use your framework's built-in mechanism)

## When You DON'T Need Effects

Avoid Effects for:

1. **Transforming data for rendering** - Calculate at the top level instead
2. **Handling user events** - Use event handlers where you know exactly what happened
3. **Deriving state** - Just compute it: `const fullName = firstName + ' ' + lastName`
4. **Chaining state updates** - Calculate all next state in the event handler
5. **Notifying parent components** - Call the callback in the same event handler
6. **Resetting state** - Use the `key` prop to create a fresh component instance

## Best Practices

### 1. Start Without an Effect

Before adding an Effect, ask: "Is there an external system involved?" If no, you probably don't need an Effect.

### 2. Prefer Derived State

If you can calculate a value from props or state, don't store it in state with an Effect updating it.

### 3. Use the Right Tool

- Expensive calculation → `useMemo`
- User interaction → Event handler
- Reset on prop change → `key` prop
- External subscription → `useSyncExternalStore`
- Shared state → Lift state up

### 4. Always Clean Up

If your Effect subscribes, fetches, or sets timers, return a cleanup function to prevent memory leaks and race conditions.

### 5. Avoid Effect Chains

Multiple Effects triggering each other causes unnecessary re-renders and makes code hard to follow. Calculate everything in one place (usually an event handler).

### 6. Test in Strict Mode

React 18+ Strict Mode mounts components twice in development to expose missing cleanup. If your Effect breaks, you need cleanup.

### 7. Consider Framework Solutions

For data fetching, prefer your framework's built-in solution (Next.js, Remix) or libraries (React Query, SWR) over manual Effects.

## Reference Files

This skill includes three detailed reference documents:

1. **SKILL.md** - Quick reference table and decision tree
2. **anti-patterns.md** - 9 common mistakes with detailed explanations
3. **alternatives.md** - 8 better alternatives with code examples

## Common Pitfalls

### Multiple Re-renders

**Symptom:** Component re-renders many times in quick succession.

**Cause:** Effect that sets state based on state it depends on, creating a loop.

**Fix:** Calculate the final value in an event handler or during render.

### Stale Data

**Symptom:** UI shows outdated values briefly before updating.

**Cause:** Using Effect to update derived state causes an extra render pass.

**Fix:** Calculate derived values during render instead of in state.

### Race Conditions

**Symptom:** Fast typing shows results for old queries after new ones.

**Cause:** Missing cleanup in data fetching Effect.

**Fix:** Use cleanup flag (`ignore` variable) or AbortController.

### Runs Twice in Development

**Symptom:** Effect runs twice on component mount in development.

**Cause:** React 18 Strict Mode intentionally mounts components twice to expose bugs.

**Fix:** Add proper cleanup. If it's app initialization that shouldn't run twice, use a module-level guard.

## Resources

This skill is based on:

- [React Official Docs: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
- [React Official Docs: Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)
- [React Official Docs: Lifecycle of Reactive Effects](https://react.dev/learn/lifecycle-of-reactive-effects)

## Summary

The golden rule: **Effects are an escape hatch from React.** If you're not synchronizing with an external system, you probably don't need an Effect.

Before writing `useEffect`, ask yourself:

1. Is this responding to a user interaction? → Use event handler
2. Is this a value I can calculate from props/state? → Calculate during render
3. Is this resetting state when a prop changes? → Use key prop
4. Is this synchronizing with an external system? → Use Effect with cleanup

Follow these patterns, and your React code will be more maintainable, performant, and bug-free.
