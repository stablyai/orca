---
title: Prefer Native Array Methods Over Lodash
impact: LOW-MEDIUM
impactDescription: eliminates library overhead, enables tree-shaking
tags: runtime, arrays, lodash, native-methods, bundling
---

## Prefer Native Array Methods Over Lodash

Modern JavaScript includes most common array operations. Native methods are faster (no function call overhead) and don't add bundle weight. Use native methods when they provide equivalent functionality.

**Incorrect (lodash for native operations):**

```typescript
import _ from 'lodash'  // Imports entire library

const activeUsers = _.filter(users, u => u.isActive)
const userNames = _.map(activeUsers, u => u.name)
const firstAdmin = _.find(users, u => u.role === 'admin')
const hasAdmin = _.some(users, u => u.role === 'admin')
const allActive = _.every(users, u => u.isActive)
const userIds = _.uniq(users.map(u => u.id))
```

**Correct (native methods):**

```typescript
const activeUsers = users.filter(u => u.isActive)
const userNames = activeUsers.map(u => u.name)
const firstAdmin = users.find(u => u.role === 'admin')
const hasAdmin = users.some(u => u.role === 'admin')
const allActive = users.every(u => u.isActive)
const userIds = [...new Set(users.map(u => u.id))]
```

**Native replacements for common Lodash functions:**

```typescript
// _.flatten / _.flattenDeep
const flat = nestedArrays.flat(Infinity)

// _.chunk (still useful from lodash)
function chunk<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size)
  )
}

// _.groupBy
function groupBy<T>(array: T[], key: keyof T): Record<string, T[]> {
  return array.reduce((groups, item) => {
    const group = String(item[key])
    groups[group] = groups[group] ?? []
    groups[group].push(item)
    return groups
  }, {} as Record<string, T[]>)
}

// Object.groupBy (ES2024)
const grouped = Object.groupBy(users, user => user.role)

// _.pick / _.omit
const { password, ...userWithoutPassword } = user  // omit
const { id, name } = user  // pick
```

**When Lodash is still valuable:**
- `_.debounce`, `_.throttle` - complex timing logic
- `_.cloneDeep` - deep object cloning
- `_.merge` - deep object merging
- `_.get` with default values (but optional chaining often suffices)

Reference: [You Don't Need Lodash](https://github.com/you-dont-need/You-Dont-Need-Lodash-Underscore)
