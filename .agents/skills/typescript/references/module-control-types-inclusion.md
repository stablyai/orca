---
title: Control @types Package Inclusion
impact: HIGH
impactDescription: prevents type conflicts and reduces memory usage
tags: module, types, tsconfig, declaration-files, performance
---

## Control @types Package Inclusion

By default, TypeScript loads all `@types/*` packages from `node_modules`. This causes conflicts between incompatible type versions and wastes memory loading unused declarations.

**Incorrect (loads all @types automatically):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext"
  }
}
```

```bash
# All @types/* packages loaded:
# @types/node, @types/react, @types/express, @types/lodash,
# @types/jest, @types/mocha (conflict!), @types/jasmine (conflict!)
```

**Correct (explicit types inclusion):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "types": ["node", "react", "jest"]
  }
}
```

```bash
# Only specified @types loaded
# No conflicts between test frameworks
```

**For different environments:**

```json
// tsconfig.json (base)
{
  "compilerOptions": {
    "types": []
  }
}

// tsconfig.node.json (Node.js scripts)
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"]
  }
}

// tsconfig.test.json (Jest tests)
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node", "jest"]
  }
}
```

**Using typeRoots for custom declarations:**

```json
{
  "compilerOptions": {
    "typeRoots": [
      "./types",           // Custom declarations first
      "./node_modules/@types"  // Then @types
    ],
    "types": ["node"]
  }
}
```

**Benefits:**
- Prevents type conflicts between similar packages
- Reduces memory usage during compilation
- Faster IDE responsiveness

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#controlling-types-inclusion)
