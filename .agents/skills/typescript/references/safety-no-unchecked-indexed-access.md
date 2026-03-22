---
title: Enable noUncheckedIndexedAccess
impact: MEDIUM-HIGH
impactDescription: prevents 100% of unchecked index access errors at compile time
tags: safety, noUncheckedIndexedAccess, strict, arrays, undefined
---

## Enable noUncheckedIndexedAccess

With `noUncheckedIndexedAccess` enabled, TypeScript adds `undefined` to the type of array elements and index signature properties. This catches one of the most common sources of runtime errors — accessing elements that may not exist.

**Incorrect (without noUncheckedIndexedAccess):**

```json
{
  "compilerOptions": {
    "strict": true
  }
}
```

```typescript
const users = ['Alice', 'Bob', 'Charlie']
const first = users[0]  // Type: string (lies — could be undefined)
console.log(first.toUpperCase())  // No error, but crashes if array is empty

const scores: Record<string, number> = { math: 95 }
const science = scores['science']  // Type: number (lies — key doesn't exist)
console.log(science.toFixed(2))  // No error, but crashes at runtime
```

**Correct (with noUncheckedIndexedAccess):**

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

```typescript
const users = ['Alice', 'Bob', 'Charlie']
const first = users[0]  // Type: string | undefined
console.log(first.toUpperCase())  // Error: 'first' is possibly undefined

// Handle the undefined case
if (first) {
  console.log(first.toUpperCase())  // OK after narrowing
}

const scores: Record<string, number> = { math: 95 }
const science = scores['science']  // Type: number | undefined
if (science !== undefined) {
  console.log(science.toFixed(2))  // OK after narrowing
}
```

**Common patterns with noUncheckedIndexedAccess:**

```typescript
// Array destructuring — first element is T | undefined
const [head, ...rest] = items
if (head) {
  processItem(head)
}

// Use non-null assertion only when you've validated
function getRequired(items: string[], index: number): string {
  if (index < 0 || index >= items.length) {
    throw new RangeError(`Index ${index} out of bounds`)
  }
  return items[index]!  // Safe — bounds checked above
}

// Array.at() returns T | undefined regardless of this flag
const last = items.at(-1)  // Already T | undefined
```

**When to disable:**
- Legacy codebases with heavy array indexing (migration cost too high)
- Performance-critical inner loops where the narrowing pattern adds overhead

Reference: [TypeScript tsconfig - noUncheckedIndexedAccess](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html)
