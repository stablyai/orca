---
title: Use Branded Types for Type-Safe IDs
impact: LOW
impactDescription: prevents mixing incompatible ID types
tags: advanced, branded-types, nominal-types, type-safety, ids
---

## Use Branded Types for Type-Safe IDs

TypeScript uses structural typing, so `string` types are interchangeable even when they represent different concepts. Branded types add a unique marker to prevent mixing incompatible values.

**Incorrect (structural typing allows mixing):**

```typescript
type UserId = string
type OrderId = string
type ProductId = string

function fetchUser(id: UserId): Promise<User> { /* ... */ }
function fetchOrder(id: OrderId): Promise<Order> { /* ... */ }

const userId: UserId = 'user-123'
const orderId: OrderId = 'order-456'

// No error - all strings are interchangeable
fetchUser(orderId)  // Bug: passed OrderId to UserId parameter
fetchOrder(userId)  // Bug: passed UserId to OrderId parameter
```

**Correct (branded types prevent mixing):**

```typescript
type Brand<K, T> = K & { __brand: T }

type UserId = Brand<string, 'UserId'>
type OrderId = Brand<string, 'OrderId'>
type ProductId = Brand<string, 'ProductId'>

function createUserId(id: string): UserId {
  return id as UserId
}

function createOrderId(id: string): OrderId {
  return id as OrderId
}

function fetchUser(id: UserId): Promise<User> { /* ... */ }
function fetchOrder(id: OrderId): Promise<Order> { /* ... */ }

const userId = createUserId('user-123')
const orderId = createOrderId('order-456')

fetchUser(orderId)  // Error: Argument of type 'OrderId' is not assignable to 'UserId'
fetchOrder(userId)  // Error: Argument of type 'UserId' is not assignable to 'OrderId'
fetchUser(userId)   // OK
```

**For numeric types:**

```typescript
type Cents = Brand<number, 'Cents'>
type Dollars = Brand<number, 'Dollars'>

function toCents(dollars: Dollars): Cents {
  return (dollars * 100) as Cents
}

function formatPrice(cents: Cents): string {
  return `$${(cents / 100).toFixed(2)}`
}

const price = 29.99 as Dollars
formatPrice(price)  // Error: Dollars not assignable to Cents
formatPrice(toCents(price))  // OK: '$29.99'
```

**When to use branded types:**
- Entity IDs that shouldn't be mixed
- Currency/unit conversions
- Validated strings (email, URL, slug)
- Sensitive data that needs tracking

Reference: [TypeScript Playground - Nominal Typing](https://www.typescriptlang.org/play/typescript/language-extensions/nominal-typing.ts.html)
