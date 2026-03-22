---
title: Enable strictNullChecks
impact: MEDIUM-HIGH
impactDescription: prevents null/undefined runtime errors
tags: safety, strictNullChecks, null, undefined, strict
---

## Enable strictNullChecks

With `strictNullChecks`, TypeScript distinguishes between `T`, `T | null`, and `T | undefined`. This catches null pointer exceptions at compile time instead of runtime.

**Incorrect (strictNullChecks disabled):**

```typescript
// tsconfig.json: { "strictNullChecks": false }

function getUser(id: string): User {
  return userMap.get(id)  // Returns User | undefined, but typed as User
}

const user = getUser('123')
console.log(user.email)  // No error, but crashes if user is undefined
```

**Correct (strictNullChecks enabled):**

```typescript
// tsconfig.json: { "strict": true } (includes strictNullChecks)

function getUser(id: string): User | undefined {
  return userMap.get(id)  // Correctly typed as User | undefined
}

const user = getUser('123')
console.log(user.email)  // Error: 'user' is possibly 'undefined'

// Must handle the undefined case
if (user) {
  console.log(user.email)  // Type narrowed to User
}

// Or use optional chaining
console.log(user?.email)  // string | undefined

// Or assert when you're certain
const confirmedUser = getUser('123')!  // Non-null assertion (use sparingly)
```

**Common patterns with strictNullChecks:**

```typescript
// Default values
function greet(name: string | undefined): string {
  return `Hello, ${name ?? 'Guest'}`
}

// Guard clauses
function processOrder(order: Order | null): void {
  if (!order) {
    throw new Error('Order is required')
  }
  // order is narrowed to Order
  ship(order)
}

// Optional chaining with nullish coalescing
const street = user?.address?.street ?? 'Unknown'
```

**Note:** Always enable `strict: true` which includes `strictNullChecks` along with other safety checks.

Reference: [TypeScript Handbook - Strict Null Checks](https://www.typescriptlang.org/tsconfig#strictNullChecks)
