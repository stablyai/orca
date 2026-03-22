---
title: Use Modern String Methods
impact: LOW-MEDIUM
impactDescription: 2-5× faster than regex for simple patterns
tags: runtime, strings, methods, performance, readability
---

## Use Modern String Methods

Modern string methods like `startsWith()`, `endsWith()`, `includes()`, and `padStart()` are clearer and often faster than regex or manual substring operations.

**Incorrect (regex or substring for simple checks):**

```typescript
function isImageFile(filename: string): boolean {
  return /\.(jpg|png|gif)$/.test(filename)
}

function hasHttpPrefix(url: string): boolean {
  return url.substring(0, 7) === 'http://' || url.substring(0, 8) === 'https://'
}

function containsSearchTerm(text: string, term: string): boolean {
  return text.indexOf(term) !== -1
}

function formatOrderId(id: number): string {
  return ('000000' + id).slice(-6)  // Pad to 6 digits
}
```

**Correct (modern string methods):**

```typescript
function isImageFile(filename: string): boolean {
  return filename.endsWith('.jpg') ||
         filename.endsWith('.png') ||
         filename.endsWith('.gif')
}

function hasHttpPrefix(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

function containsSearchTerm(text: string, term: string): boolean {
  return text.includes(term)
}

function formatOrderId(id: number): string {
  return String(id).padStart(6, '0')
}
```

**Additional useful methods:**

```typescript
// replaceAll (no global regex needed)
const sanitized = input.replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// at() for negative indexing
const lastChar = filename.at(-1)  // Last character
const extension = filename.split('.').at(-1)  // Last segment

// trimStart/trimEnd for directional trimming
const trimmedLeft = '   text   '.trimStart()   // 'text   '
const trimmedRight = '   text   '.trimEnd()    // '   text'

// repeat for string multiplication
const separator = '-'.repeat(40)
const indent = '  '.repeat(depth)
```

**When regex is still needed:**
- Complex pattern matching
- Capture groups
- Case-insensitive matching (`/pattern/i`)
- Multiple conditions in one check

Reference: [MDN String Methods](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String)
