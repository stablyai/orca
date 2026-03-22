---
title: Use satisfies for Type Validation with Inference
impact: LOW
impactDescription: prevents property access errors, enables 100% autocomplete accuracy
tags: advanced, satisfies, inference, validation, type-checking
---

## Use satisfies for Type Validation with Inference

The `satisfies` operator validates that a value conforms to a type while preserving the narrower inferred type. This gives you both type safety and precise autocomplete.

**Incorrect (type annotation loses literal types):**

```typescript
type ColorConfig = Record<string, [number, number, number]>

const colors: ColorConfig = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  // Can't access colors.red - it's just string keys
}

// TypeScript doesn't know 'red' is a valid key
const redValue = colors.red    // Type: [number, number, number]
const pinkValue = colors.pink  // No error! Type: [number, number, number]
```

**Correct (satisfies preserves literal types):**

```typescript
type ColorConfig = Record<string, [number, number, number]>

const colors = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
} satisfies ColorConfig

// TypeScript knows exact keys
const redValue = colors.red    // Type: [number, number, number]
const pinkValue = colors.pink  // Error: Property 'pink' does not exist
```

**For configuration objects:**

```typescript
interface Route {
  path: string
  component: () => JSX.Element
  auth?: boolean
}

// Without satisfies - loses literal path types
const routes: Route[] = [
  { path: '/', component: Home },
  { path: '/users', component: Users },
]
// routes[0].path is just 'string'

// With satisfies - preserves literal paths
const routes = [
  { path: '/', component: Home },
  { path: '/users', component: Users },
] satisfies Route[]
// routes[0].path is '/'

type RoutePath = typeof routes[number]['path']  // '/' | '/users'
```

**Combining with as const:**

```typescript
const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
  retries: 3,
} as const satisfies {
  apiUrl: string
  timeout: number
  retries: number
}

// Both validated AND readonly with literal types
config.apiUrl  // Type: 'https://api.example.com' (not just string)
config.timeout = 3000  // Error: Cannot assign to 'timeout' (readonly)
```

**When to use satisfies vs type annotation:**
- Use `satisfies` when you want validation but need literal types
- Use type annotation (`:`) when you want the variable to be exactly that type
- Use `as const satisfies` for readonly config with validation

Reference: [TypeScript 4.9 satisfies](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
