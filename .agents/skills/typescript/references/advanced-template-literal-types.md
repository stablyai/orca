---
title: Use Template Literal Types for String Patterns
impact: LOW
impactDescription: prevents 100% of string format errors at compile time
tags: advanced, template-literals, string-types, patterns, validation
---

## Use Template Literal Types for String Patterns

Template literal types allow defining string patterns at the type level. TypeScript validates that strings match the expected format at compile time.

**Incorrect (plain string allows any value):**

```typescript
type EventHandler = {
  event: string
  handler: () => void
}

const handler: EventHandler = {
  event: 'click',  // OK
  handler: () => {}
}

const badHandler: EventHandler = {
  event: 'clck',  // Typo - no error
  handler: () => {}
}

function addEventListener(event: string, handler: () => void): void { }
addEventListener('onlcick', () => {})  // Typo compiles fine
```

**Correct (template literal type validates pattern):**

```typescript
type DOMEvent = 'click' | 'focus' | 'blur' | 'submit' | 'change'
type EventHandlerName = `on${Capitalize<DOMEvent>}`

type EventHandler = {
  event: EventHandlerName
  handler: () => void
}

const handler: EventHandler = {
  event: 'onClick',  // OK
  handler: () => {}
}

const badHandler: EventHandler = {
  event: 'onClck',  // Error: Type '"onClck"' is not assignable to type 'EventHandlerName'
  handler: () => {}
}
```

**For CSS-like patterns:**

```typescript
type CSSUnit = 'px' | 'em' | 'rem' | '%' | 'vh' | 'vw'
type CSSValue = `${number}${CSSUnit}`

function setWidth(element: HTMLElement, width: CSSValue): void {
  element.style.width = width
}

setWidth(div, '100px')   // OK
setWidth(div, '2.5rem')  // OK
setWidth(div, '100')     // Error: Type '"100"' is not assignable to type 'CSSValue'
setWidth(div, '100pixels')  // Error
```

**For API route patterns:**

```typescript
type APIVersion = 'v1' | 'v2'
type Resource = 'users' | 'orders' | 'products'
type APIRoute = `/api/${APIVersion}/${Resource}`

function fetchResource(route: APIRoute): Promise<Response> {
  return fetch(route)
}

fetchResource('/api/v1/users')    // OK
fetchResource('/api/v2/orders')   // OK
fetchResource('/api/v3/users')    // Error: 'v3' not in APIVersion
fetchResource('/users')           // Error: doesn't match pattern
```

**Combining with mapped types:**

```typescript
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K]
}

interface User {
  name: string
  age: number
}

type UserGetters = Getters<User>
// { getName: () => string; getAge: () => number }
```

Reference: [TypeScript 4.1 Template Literal Types](https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html)
