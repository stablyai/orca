---
title: Configure Include and Exclude Properly
impact: CRITICAL
impactDescription: prevents scanning thousands of unnecessary files
tags: tscfg, include, exclude, tsconfig, file-discovery
---

## Configure Include and Exclude Properly

TypeScript walks through all included directories to discover files. Overly broad `include` patterns or missing `exclude` patterns force the compiler to scan irrelevant directories, significantly slowing startup.

**Incorrect (scans entire project tree):**

```json
{
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["**/*"]
}
```

```bash
# Scans node_modules, dist, coverage, .git...
# Discovery time: 5+ seconds on large projects
```

**Correct (targeted include with explicit exclude):**

```json
{
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": [
    "node_modules",
    "dist",
    "coverage",
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/__tests__/**"
  ]
}
```

```bash
# Only scans src/ directory
# Discovery time: <1 second
```

**For separate test configuration:**

```json
// tsconfig.json (production)
{
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts"]
}

// tsconfig.test.json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*", "tests/**/*"]
}
```

**Diagnostic commands:**

```bash
# List all files TypeScript will compile
tsc --listFiles

# Explain why each file was included
tsc --explainFiles
```

**Common files to exclude:**
- `node_modules` (always)
- Build output directories (`dist`, `build`, `out`)
- Test files for production builds
- Generated files (`.generated.ts`)
- Coverage reports (`coverage`)

Reference: [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance#configuring-tsconfigjson-or-jsconfigjson)
