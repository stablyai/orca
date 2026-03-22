---
title: Prefer Interfaces Over Type Intersections
impact: CRITICAL
impactDescription: 2-5× faster type resolution
tags: type, interfaces, intersections, compilation, performance
---

## Prefer Interfaces Over Type Intersections

Interfaces create a single flat object type that detects property conflicts at declaration. Intersections recursively merge properties on every use, forcing the compiler to recompute the combined type repeatedly.

**Incorrect (recursive intersection merging):**

```typescript
type UserWithPermissions = User & Permissions & AuditInfo
// Compiler merges all properties on every reference

type ExtendedOrder = Order & {
  metadata: OrderMetadata
} & Timestamps
// Each intersection adds another layer of computation
```

**Correct (single flat interface):**

```typescript
interface UserWithPermissions extends User, Permissions, AuditInfo {}
// Single flat type, computed once

interface ExtendedOrder extends Order, Timestamps {
  metadata: OrderMetadata
}
// Extends create efficient inheritance chain
```

**When to use intersections:**
- Combining function types or primitives (interfaces cannot extend these)
- Creating mapped or conditional types
- One-off type combinations not reused elsewhere

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#preferring-interfaces-over-intersections)
