---
name: react-useeffect
description: React useEffect best practices from official docs. Use when writing/reviewing useEffect, useState for derived values, data fetching, or state synchronization. Teaches when NOT to use Effect and better alternatives.
---

# You Might Not Need an Effect

Effects are an **escape hatch** from React. They let you synchronize with external systems. If there is no external system involved, you shouldn't need an Effect.

## Quick Reference

| Situation                      | DON'T                          | DO                                    |
| ------------------------------ | ------------------------------ | ------------------------------------- |
| Derived state from props/state | `useState` + `useEffect`       | Calculate during render               |
| Expensive calculations         | `useEffect` to cache           | `useMemo`                             |
| Reset state on prop change     | `useEffect` with `setState`    | `key` prop                            |
| User event responses           | `useEffect` watching state     | Event handler directly                |
| Notify parent of changes       | `useEffect` calling `onChange` | Call in event handler                 |
| Fetch data                     | `useEffect` without cleanup    | `useEffect` with cleanup OR framework |

## When You DO Need Effects

- Synchronizing with **external systems** (non-React widgets, browser APIs)
- **Subscriptions** to external stores (use `useSyncExternalStore` when possible)
- **Analytics/logging** that runs because component displayed
- **Data fetching** with proper cleanup (or use framework's built-in mechanism)

## When You DON'T Need Effects

1. **Transforming data for rendering** - Calculate at top level, re-runs automatically
2. **Handling user events** - Use event handlers, you know exactly what happened
3. **Deriving state** - Just compute it: `const fullName = firstName + ' ' + lastName`
4. **Chaining state updates** - Calculate all next state in the event handler

## Decision Tree

```
Need to respond to something?
├── User interaction (click, submit, drag)?
│   └── Use EVENT HANDLER
├── Component appeared on screen?
│   └── Use EFFECT (external sync, analytics)
├── Props/state changed and need derived value?
│   └── CALCULATE DURING RENDER
│       └── Expensive? Use useMemo
└── Need to reset state when prop changes?
    └── Use KEY PROP on component
```

## Detailed Guidance

- [Anti-Patterns](./anti-patterns.md) - Common mistakes with fixes
- [Better Alternatives](./alternatives.md) - useMemo, key prop, lifting state, useSyncExternalStore
