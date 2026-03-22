---
title: Use Type-Only Imports for Types
impact: HIGH
impactDescription: eliminates runtime imports for type information
tags: module, type-imports, tree-shaking, bundling, compilation
---

## Use Type-Only Imports for Types

Type-only imports (`import type`) are completely erased during compilation, preventing unnecessary runtime module loading. Regular imports of types can force module execution even when only the type is needed.

**Incorrect (runtime import for type-only usage):**

```typescript
// config.ts
import { DatabaseConfig } from './database'  // Loads entire database module
import { Logger } from './logger'  // Loads entire logger module

interface AppConfig {
  db: DatabaseConfig
  logger: Logger
}

// Runtime: database.js and logger.js are both loaded
// even though we only use their types
```

**Correct (type-only imports):**

```typescript
// config.ts
import type { DatabaseConfig } from './database'
import type { Logger } from './logger'

interface AppConfig {
  db: DatabaseConfig
  logger: Logger
}

// Runtime: no modules loaded, types are erased
```

**Mixed imports (types and values):**

```typescript
// Incorrect - unclear what's type vs value
import { User, createUser, UserRole } from './user'

// Correct - explicit separation
import { createUser } from './user'
import type { User, UserRole } from './user'

// Or inline type imports (TypeScript 4.5+)
import { createUser, type User, type UserRole } from './user'
```

**Enable enforcement:**

```json
// tsconfig.json
{
  "compilerOptions": {
    "verbatimModuleSyntax": true
  }
}

// .eslintrc
{
  "rules": {
    "@typescript-eslint/consistent-type-imports": "error"
  }
}
```

**Benefits:**
- Smaller bundles (unused modules not included)
- Faster cold starts (fewer modules to parse)
- Clearer code intent (types vs runtime values)

Reference: [TypeScript 3.8 Release Notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html#type-only-imports-and-export)
