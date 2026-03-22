---
title: Use Set/Map for O(1) Lookups
impact: LOW-MEDIUM
impactDescription: O(n) to O(1) per lookup
tags: runtime, set, map, lookup, performance
---

## Use Set/Map for O(1) Lookups

Array methods like `.includes()` and `.find()` are O(n) operations. For frequent lookups, convert arrays to Set or Map for O(1) access.

**Incorrect (O(n) per lookup):**

```typescript
const allowedRoles = ['admin', 'editor', 'viewer', 'moderator']

function hasPermission(userRole: string): boolean {
  return allowedRoles.includes(userRole)  // O(n) every call
}

// In a loop, this becomes O(n × m)
function filterAuthorizedUsers(users: User[]): User[] {
  return users.filter(user => allowedRoles.includes(user.role))
  // 1000 users × 4 roles = 4000 comparisons
}
```

**Correct (O(1) per lookup):**

```typescript
const allowedRoles = new Set(['admin', 'editor', 'viewer', 'moderator'])

function hasPermission(userRole: string): boolean {
  return allowedRoles.has(userRole)  // O(1) every call
}

function filterAuthorizedUsers(users: User[]): User[] {
  return users.filter(user => allowedRoles.has(user.role))
  // 1000 users × O(1) = 1000 operations
}
```

**For object lookups by key:**

```typescript
// Incorrect - O(n) search
const users: User[] = [/* ... */]
function findUserById(id: string): User | undefined {
  return users.find(u => u.id === id)  // Scans entire array
}

// Correct - O(1) lookup
const userById = new Map<string, User>(users.map(u => [u.id, u]))
function findUserById(id: string): User | undefined {
  return userById.get(id)
}
```

**When to stick with arrays:**
- Small collections (< 10 items)
- One-time lookups where conversion cost exceeds benefit
- When you need array methods like `.map()`, `.filter()`, `.slice()`

Reference: [MDN Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)
