---
title: Enable skipLibCheck for Faster Builds
impact: CRITICAL
impactDescription: 20-40% faster compilation
tags: tscfg, skipLibCheck, tsconfig, declaration-files, performance
---

## Enable skipLibCheck for Faster Builds

The `skipLibCheck` option skips type-checking of declaration files (`.d.ts`). Since these files are pre-verified by library authors, checking them is redundant and wastes compilation time.

**Incorrect (checks all declaration files):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "strict": true
  }
}
```

```bash
# Checks thousands of .d.ts files in node_modules
# Compilation time: 25 seconds
```

**Correct (skips declaration file checks):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "strict": true,
    "skipLibCheck": true
  }
}
```

```bash
# Only checks your source files
# Compilation time: 15 seconds (40% faster)
```

**Alternative (more conservative):**

```json
{
  "compilerOptions": {
    "skipDefaultLibCheck": true
  }
}
```

This only skips checking the default library files (lib.d.ts), not third-party declarations.

**When to disable skipLibCheck:**
- Debugging type conflicts between declaration files
- Publishing a library where you want to verify `.d.ts` output
- Encountering mysterious type errors that might originate in declarations

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#skipping-d-ts-checking)
