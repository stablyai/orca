---
title: Use Type Guards for Runtime Type Checking
impact: MEDIUM-HIGH
impactDescription: eliminates type assertions, catches errors at boundaries
tags: safety, type-guards, narrowing, predicates, validation
---

## Use Type Guards for Runtime Type Checking

Type guards provide runtime validation that TypeScript can use for static narrowing. They replace unsafe type assertions with checked operations.

**Incorrect (type assertions without validation):**

```typescript
interface User {
  id: string
  email: string
  role: 'admin' | 'user'
}

function handleUserEvent(event: MessageEvent): void {
  const user = event.data as User  // Unsafe assertion
  sendEmail(user.email)  // Crashes if data isn't actually a User
}

function processResponse(data: unknown): User[] {
  return data as User[]  // No runtime check
}
```

**Correct (type guard with validation):**

```typescript
function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as User).id === 'string' &&
    typeof (value as User).email === 'string' &&
    ['admin', 'user'].includes((value as User).role)
  )
}

function handleUserEvent(event: MessageEvent): void {
  if (!isUser(event.data)) {
    console.error('Invalid user data received')
    return
  }
  sendEmail(event.data.email)  // Type-safe: event.data is User
}

function processResponse(data: unknown): User[] {
  if (!Array.isArray(data)) return []
  return data.filter(isUser)
}
```

**For discriminated unions:**

```typescript
interface SuccessResult {
  status: 'success'
  data: User
}

interface ErrorResult {
  status: 'error'
  message: string
}

type ApiResult = SuccessResult | ErrorResult

function isSuccess(result: ApiResult): result is SuccessResult {
  return result.status === 'success'
}

function handleResult(result: ApiResult): void {
  if (isSuccess(result)) {
    console.log(result.data.email)  // Type narrowed to SuccessResult
  } else {
    console.error(result.message)  // Type narrowed to ErrorResult
  }
}
```

Reference: [TypeScript Handbook - Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
