---
title: Enable Incremental Compilation
impact: CRITICAL
impactDescription: 50-90% faster rebuilds
tags: tscfg, incremental, tsconfig, compilation, caching
---

## Enable Incremental Compilation

Incremental compilation caches project graph information between builds in a `.tsbuildinfo` file. Subsequent compilations only recheck changed files and their dependents.

**Incorrect (full rebuild every time):**

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
tsc  # 15 seconds every build
```

**Correct (incremental builds):**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "strict": true,
    "incremental": true,
    "tsBuildInfoFile": "./dist/.tsbuildinfo"
  }
}
```

```bash
tsc  # 15s first build, 1-3s subsequent builds
```

**For monorepos (composite projects):**

```json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "declarationMap": true
  },
  "references": [
    { "path": "../shared" },
    { "path": "../utils" }
  ]
}
```

**Note:** The `composite` flag implies `incremental: true` and requires `declaration: true`.

**When to disable incremental:**
- CI environments where cache isn't preserved between runs
- One-off type-checking scripts

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#incremental-project-emit)
