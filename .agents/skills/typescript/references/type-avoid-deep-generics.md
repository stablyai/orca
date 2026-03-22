---
title: Avoid Deeply Nested Generic Types
impact: CRITICAL
impactDescription: prevents exponential instantiation cost
tags: type, generics, nesting, instantiation, performance
---

## Avoid Deeply Nested Generic Types

Each layer of generic nesting multiplies type instantiation cost. Flatten generic hierarchies or use intermediate type aliases to reduce the combinatorial explosion of type checking.

**Incorrect (deeply nested generics):**

```typescript
type ApiResponse<T> = {
  data: T
  meta: ResponseMeta
}

type PaginatedResponse<T> = ApiResponse<{
  items: T[]
  pagination: PaginationInfo
}>

type CachedResponse<T> = PaginatedResponse<{
  value: T
  cachedAt: Date
}>

// Usage creates 4+ levels of nesting
function fetchUsers(): CachedResponse<User> { }
// Compiler must resolve: CachedResponse<User> → PaginatedResponse<...> → ApiResponse<...>
```

**Correct (flattened with composition):**

```typescript
interface PaginationInfo {
  page: number
  totalPages: number
}

interface CacheInfo {
  cachedAt: Date
}

interface PaginatedData<T> {
  items: T[]
  pagination: PaginationInfo
}

interface ApiResponse<T> {
  data: T
  meta: ResponseMeta
}

// Compose at usage site instead of nesting
type UserListResponse = ApiResponse<PaginatedData<User> & CacheInfo>

function fetchUsers(): UserListResponse { }
// Single-level generic instantiation
```

**Alternative (builder pattern for complex responses):**

```typescript
interface ResponseBuilder<T> {
  data: T
  meta: ResponseMeta
}

function withPagination<T>(items: T[], pagination: PaginationInfo): PaginatedData<T> {
  return { items, pagination }
}

function withCache<T>(value: T): T & CacheInfo {
  return { ...value, cachedAt: new Date() }
}
```

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance)
