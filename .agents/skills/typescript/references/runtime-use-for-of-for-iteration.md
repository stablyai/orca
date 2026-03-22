---
title: Use for-of for Simple Iteration
impact: LOW-MEDIUM
impactDescription: reduces iteration boilerplate by 30-50%
tags: runtime, loops, iteration, for-of, readability
---

## Use for-of for Simple Iteration

`for-of` provides clean syntax for array iteration with performance comparable to traditional `for` loops. Use it when you don't need the index and aren't modifying the array.

**Incorrect (index-based when index isn't needed):**

```typescript
function calculateTotal(orders: Order[]): number {
  let total = 0
  for (let i = 0; i < orders.length; i++) {
    total += orders[i].amount
  }
  return total
}

function processUsers(users: User[]): void {
  for (let i = 0; i < users.length; i++) {
    sendNotification(users[i])
  }
}
```

**Correct (for-of for clean iteration):**

```typescript
function calculateTotal(orders: Order[]): number {
  let total = 0
  for (const order of orders) {
    total += order.amount
  }
  return total
}

function processUsers(users: User[]): void {
  for (const user of users) {
    sendNotification(user)
  }
}
```

**When to use each pattern:**

```typescript
// for-of: when you only need values
for (const item of items) {
  process(item)
}

// forEach: when you want functional style (but can't break/return)
items.forEach(item => process(item))

// for-in: only for object keys (never for arrays)
for (const key in config) {
  console.log(key, config[key])
}

// Traditional for: when you need index, or need to modify loop
for (let i = 0; i < items.length; i++) {
  if (items[i].id === targetId) {
    items[i] = updatedItem  // Modifying array
    break  // Early exit
  }
}

// entries(): when you need both index and value
for (const [index, item] of items.entries()) {
  console.log(`${index}: ${item.name}`)
}
```

**Avoid for-in for arrays:**

```typescript
// NEVER do this
for (const index in items) {
  // index is a string, not number
  // Iterates inherited properties
  // Wrong order not guaranteed
}
```

Reference: [MDN for...of](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for...of)
