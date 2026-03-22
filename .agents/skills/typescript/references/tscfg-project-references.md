---
title: Use Project References for Large Codebases
impact: CRITICAL
impactDescription: 60-80% faster incremental builds
tags: tscfg, project-references, monorepo, tsconfig, compilation
---

## Use Project References for Large Codebases

Project references split a codebase into independent compilation units. Each project compiles separately, enabling parallel builds and preventing the compiler from loading the entire codebase at once.

**Incorrect (monolithic tsconfig):**

```text
my-app/
├── tsconfig.json        # Single config for entire app
├── packages/
│   ├── api/src/
│   ├── web/src/
│   └── shared/src/
```

```json
{
  "compilerOptions": { "outDir": "dist" },
  "include": ["packages/*/src/**/*"]
}
```

```bash
# Loads ALL files into memory for every change
# Change in api/ triggers full recompile
```

**Correct (project references):**

```text
my-app/
├── tsconfig.json              # Root config with references
├── packages/
│   ├── api/
│   │   └── tsconfig.json      # References shared
│   ├── web/
│   │   └── tsconfig.json      # References shared
│   └── shared/
│       └── tsconfig.json      # No references (leaf)
```

```json
// packages/shared/tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

```json
// packages/api/tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "outDir": "dist"
  },
  "references": [
    { "path": "../shared" }
  ],
  "include": ["src/**/*"]
}
```

```json
// tsconfig.json (root)
{
  "files": [],
  "references": [
    { "path": "packages/shared" },
    { "path": "packages/api" },
    { "path": "packages/web" }
  ]
}
```

```bash
tsc --build  # Builds only changed projects
```

**Benefits:**
- Parallel compilation of independent projects
- Change in `shared/` only rebuilds dependents
- Declaration files used as API boundaries

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#using-project-references)
