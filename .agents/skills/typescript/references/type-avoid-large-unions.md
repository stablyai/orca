---
title: Avoid Large Union Types
impact: CRITICAL
impactDescription: quadratic O(n²) comparison cost
tags: type, unions, compilation, performance, discriminated-unions
---

## Avoid Large Union Types

Union type checking is quadratic — TypeScript compares each union member pairwise. Unions with 50+ elements cause measurable compilation slowdowns and IDE lag. This commonly occurs with generated types (GraphQL schemas, API response codes, database enums).

**Incorrect (large generated union, O(n²) checks):**

```typescript
// Auto-generated from GraphQL schema — 200+ event types
type AnalyticsEvent =
  | 'page_view' | 'button_click' | 'form_submit' | 'scroll_depth'
  | 'video_play' | 'video_pause' | 'video_complete' | 'ad_impression'
  // ... 200 more event types from analytics schema
// 200 members = 40,000 pairwise comparisons per usage
```

**Correct (branded string type with runtime validation):**

```typescript
type AnalyticsEvent = string & { readonly __brand: 'AnalyticsEvent' }

const VALID_EVENTS = new Set(['page_view', 'button_click', 'form_submit', /* ... */])

function createEvent(name: string): AnalyticsEvent {
  if (!VALID_EVENTS.has(name)) {
    throw new Error(`Unknown event: ${name}`)
  }
  return name as AnalyticsEvent
}
```

**For moderately large unions (20-50 members), use discriminated unions:**

```typescript
// Group related values into categories
type UserEvent = { category: 'user'; action: 'login' | 'logout' | 'signup' }
type PageEvent = { category: 'page'; action: 'view' | 'scroll' | 'leave' }
type FormEvent = { category: 'form'; action: 'submit' | 'validate' | 'reset' }

type AppEvent = UserEvent | PageEvent | FormEvent
// Small union of 3 interfaces instead of 9+ string literals
```

**When flat unions are fine:**
- Small unions (< 20 members) have negligible cost
- Unions of primitive literals used in few places
- `string | number | boolean` style utility unions

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#preferring-base-types-over-unions)
