---
title: Avoid Unnecessary async/await
impact: HIGH
impactDescription: eliminates trivial Promise wrappers and improves stack traces
tags: async, promises, overhead, optimization, return-await
---

## Avoid Unnecessary async/await

Remove `async` from functions that only wrap a single Promise without using `await` for control flow. However, prefer `return await` over bare `return` inside try/catch blocks — it ensures errors are caught and produces better stack traces.

**Incorrect (trivial async wrapper with no logic):**

```typescript
async function getUser(userId: string): Promise<User> {
  return userRepository.findById(userId)
  // async keyword creates unnecessary Promise wrapper
  // No await, no try/catch — async adds nothing here
}

async function deleteUser(userId: string): Promise<void> {
  return userRepository.delete(userId)
  // Same pattern — async is pure overhead
}
```

**Correct (remove async when it adds nothing):**

```typescript
function getUser(userId: string): Promise<User> {
  return userRepository.findById(userId)
  // Direct Promise return, no wrapper
}

function deleteUser(userId: string): Promise<void> {
  return userRepository.delete(userId)
}
```

**Keep async + return await in try/catch:**

```typescript
// Correct — return await ensures the error is caught
async function getUser(userId: string): Promise<User> {
  try {
    return await userRepository.findById(userId)
    // Without await, rejected promise skips the catch block
  } catch (error) {
    logger.error('Failed to fetch user', { userId, error })
    throw new UserNotFoundError(userId)
  }
}
```

**When async IS needed:**
- Multiple sequential await statements
- Try/catch around await (use `return await` here)
- Conditional await logic
- Complex control flow with early returns

**Note:** ESLint deprecated `no-return-await` in v8.46.0 because `return await` is both safe and produces better stack traces. Use the `@typescript-eslint/return-await` rule with `in-try-catch` setting for nuanced control.

Reference: [ESLint no-return-await deprecation](https://eslint.org/docs/latest/rules/no-return-await)
