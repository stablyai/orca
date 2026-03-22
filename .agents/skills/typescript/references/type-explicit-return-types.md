---
title: Add Explicit Return Types to Exported Functions
impact: CRITICAL
impactDescription: 30-50% faster declaration emit
tags: type, return-types, exports, inference, performance
---

## Add Explicit Return Types to Exported Functions

Explicit return types accelerate compilation by eliminating inference overhead. Named types are more compact than inferred anonymous types, speeding up declaration file generation and consumption.

**Incorrect (inferred return type, slow declaration emit):**

```typescript
export function fetchUserProfile(userId: string) {
  // Compiler must analyze entire function body to infer return type
  return fetch(`/api/users/${userId}`)
    .then(res => res.json())
    .then(data => ({
      id: data.id as string,
      name: data.name as string,
      email: data.email as string,
      createdAt: new Date(data.created_at),
      permissions: data.permissions as Permission[],
    }))
}
// Inferred: Promise<{ id: string; name: string; email: string; createdAt: Date; permissions: Permission[] }>
```

**Correct (explicit return type, fast compilation):**

```typescript
interface UserProfile {
  id: string
  name: string
  email: string
  createdAt: Date
  permissions: Permission[]
}

export function fetchUserProfile(userId: string): Promise<UserProfile> {
  return fetch(`/api/users/${userId}`)
    .then(res => res.json())
    .then(data => ({
      id: data.id,
      name: data.name,
      email: data.email,
      createdAt: new Date(data.created_at),
      permissions: data.permissions,
    }))
}
```

**When to skip explicit return types:**
- Private/internal functions with simple returns
- Arrow functions in local scope
- Functions where the return type is obvious (e.g., `(): void`)

**Benefits:**
- Declaration files use named type instead of expanded inline type
- Faster incremental compilation when function body changes
- Better error messages pointing to return type mismatch

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#using-type-annotations)
