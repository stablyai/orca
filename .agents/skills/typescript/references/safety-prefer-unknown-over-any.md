---
title: Prefer unknown Over any
impact: MEDIUM-HIGH
impactDescription: forces type narrowing, prevents runtime errors
tags: safety, unknown, any, type-narrowing, type-safety
---

## Prefer unknown Over any

The `any` type disables all type checking, allowing unsafe operations to pass silently. Use `unknown` to require explicit type narrowing before operations.

**Incorrect (any bypasses all checks):**

```typescript
function processApiResponse(data: any): string {
  return data.user.name.toUpperCase()
  // No error even if data is null, has no user, or name isn't a string
  // Runtime: TypeError: Cannot read property 'name' of undefined
}

async function fetchData(): Promise<any> {
  const response = await fetch('/api/data')
  return response.json()  // Returns Promise<any>, loses all type info
}
```

**Correct (unknown requires narrowing):**

```typescript
interface ApiResponse {
  user: {
    name: string
  }
}

function isApiResponse(data: unknown): data is ApiResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'user' in data &&
    typeof (data as ApiResponse).user?.name === 'string'
  )
}

function processApiResponse(data: unknown): string {
  if (!isApiResponse(data)) {
    throw new Error('Invalid API response')
  }
  return data.user.name.toUpperCase()  // Type-safe access
}
```

**For JSON parsing:**

```typescript
// Incorrect
const config = JSON.parse(configString) as AppConfig  // Unsafe assertion

// Correct
function parseConfig(configString: string): AppConfig {
  const parsed: unknown = JSON.parse(configString)

  if (!isValidConfig(parsed)) {
    throw new Error('Invalid config format')
  }

  return parsed
}
```

**When any is acceptable:**
- Migrating JavaScript to TypeScript incrementally
- Third-party library workarounds (with `// @ts-expect-error`)
- Truly dynamic code where type is unknowable

Reference: [TypeScript Handbook - Unknown](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#the-unknown-type)
