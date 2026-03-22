---
name: typescript
description: This skill should be used when the user asks to "optimize TypeScript performance", "speed up tsc compilation", "configure tsconfig.json", "fix type errors", "improve async patterns", or encounters TS errors (TS2322, TS2339, "is not assignable to"). Also triggers on .ts, .tsx, .d.ts file work involving type definitions, module organization, or memory management. Does NOT cover TypeScript basics, framework-specific patterns, or testing.
---

# TypeScript Best Practices

Comprehensive performance optimization guide for TypeScript applications. Contains 45 rules across 8 categories, prioritized by impact to guide automated refactoring and code generation.

## When to Apply

Reference these guidelines when:
- Configuring tsconfig.json for a new or existing project
- Writing complex type definitions or generics
- Optimizing async/await patterns and data fetching
- Organizing modules and managing imports
- Reviewing code for compilation or runtime performance

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Type System Performance | CRITICAL | `type-` |
| 2 | Compiler Configuration | CRITICAL | `tscfg-` |
| 3 | Async Patterns | HIGH | `async-` |
| 4 | Module Organization | HIGH | `module-` |
| 5 | Type Safety Patterns | MEDIUM-HIGH | `safety-` |
| 6 | Memory Management | MEDIUM | `mem-` |
| 7 | Runtime Optimization | LOW-MEDIUM | `runtime-` |
| 8 | Advanced Patterns | LOW | `advanced-` |

## Table of Contents

1. [Type System Performance](references/_sections.md#1-type-system-performance) — **CRITICAL**
   - 1.1 [Add Explicit Return Types to Exported Functions](references/type-explicit-return-types.md) — CRITICAL (30-50% faster declaration emit)
   - 1.2 [Avoid Deeply Nested Generic Types](references/type-avoid-deep-generics.md) — CRITICAL (prevents exponential instantiation cost)
   - 1.3 [Avoid Large Union Types](references/type-avoid-large-unions.md) — CRITICAL (quadratic O(n²) comparison cost)
   - 1.4 [Extract Conditional Types to Named Aliases](references/type-extract-conditional-types.md) — CRITICAL (enables compiler caching, prevents re-evaluation)
   - 1.5 [Limit Type Recursion Depth](references/type-limit-recursion-depth.md) — HIGH (prevents exponential type expansion when applicable)
   - 1.6 [Prefer Interfaces Over Type Intersections](references/type-interfaces-over-intersections.md) — CRITICAL (2-5× faster type resolution)
   - 1.7 [Simplify Complex Mapped Types](references/type-simplify-mapped-types.md) — HIGH (reduces type computation by 50-80% when applicable)
2. [Compiler Configuration](references/_sections.md#2-compiler-configuration) — **CRITICAL**
   - 2.1 [Configure Include and Exclude Properly](references/tscfg-exclude-properly.md) — CRITICAL (prevents scanning thousands of unnecessary files)
   - 2.2 [Enable Incremental Compilation](references/tscfg-enable-incremental.md) — CRITICAL (50-90% faster rebuilds)
   - 2.3 [Enable isolatedDeclarations for Parallel Declaration Emit](references/tscfg-isolated-declarations.md) — CRITICAL (enables parallel .d.ts generation without type-checker)
   - 2.4 [Enable skipLibCheck for Faster Builds](references/tscfg-skip-lib-check.md) — CRITICAL (20-40% faster compilation)
   - 2.5 [Enable strictFunctionTypes for Faster Variance Checks](references/tscfg-strict-function-types.md) — CRITICAL (enables optimized variance checking)
   - 2.6 [Use erasableSyntaxOnly for Node.js Native TypeScript](references/tscfg-erasable-syntax-only.md) — HIGH (prevents 100% of Node.js type-stripping runtime errors)
   - 2.7 [Use isolatedModules for Single-File Transpilation](references/tscfg-isolate-modules.md) — CRITICAL (80-90% faster transpilation with bundlers)
   - 2.8 [Use Project References for Large Codebases](references/tscfg-project-references.md) — CRITICAL (60-80% faster incremental builds)
3. [Async Patterns](references/_sections.md#3-async-patterns) — **HIGH**
   - 3.1 [Annotate Async Function Return Types](references/async-explicit-return-types.md) — HIGH (prevents runtime errors, improves inference)
   - 3.2 [Avoid await Inside Loops](references/async-avoid-loop-await.md) — HIGH (N× faster for N iterations, 10 users = 10× improvement)
   - 3.3 [Avoid Unnecessary async/await](references/async-avoid-unnecessary-async.md) — HIGH (eliminates trivial Promise wrappers and improves stack traces)
   - 3.4 [Defer await Until Value Is Needed](references/async-defer-await.md) — HIGH (enables implicit parallelization)
   - 3.5 [Use Promise.all for Independent Operations](references/async-parallel-promises.md) — HIGH (2-10× improvement in I/O-bound code)
4. [Module Organization](references/_sections.md#4-module-organization) — **HIGH**
   - 4.1 [Avoid Barrel File Imports](references/module-avoid-barrel-imports.md) — HIGH (200-800ms import cost, 30-50% larger bundles)
   - 4.2 [Avoid Circular Dependencies](references/module-avoid-circular-dependencies.md) — HIGH (prevents runtime undefined errors and slow compilation)
   - 4.3 [Control @types Package Inclusion](references/module-control-types-inclusion.md) — HIGH (prevents type conflicts and reduces memory usage)
   - 4.4 [Use Dynamic Imports for Large Modules](references/module-dynamic-imports.md) — HIGH (reduces initial bundle by 30-70%)
   - 4.5 [Use Type-Only Imports for Types](references/module-use-type-imports.md) — HIGH (eliminates runtime imports for type information)
5. [Type Safety Patterns](references/_sections.md#5-type-safety-patterns) — **MEDIUM-HIGH**
   - 5.1 [Enable noUncheckedIndexedAccess](references/safety-no-unchecked-indexed-access.md) — MEDIUM-HIGH (prevents 100% of unchecked index access errors at compile time)
   - 5.2 [Enable strictNullChecks](references/safety-strict-null-checks.md) — MEDIUM-HIGH (prevents null/undefined runtime errors)
   - 5.3 [Prefer unknown Over any](references/safety-prefer-unknown-over-any.md) — MEDIUM-HIGH (forces type narrowing, prevents runtime errors)
   - 5.4 [Use Assertion Functions for Validation](references/safety-assertion-functions.md) — MEDIUM-HIGH (reduces validation boilerplate by 50-70%)
   - 5.5 [Use const Assertions for Literal Types](references/safety-const-assertions.md) — MEDIUM-HIGH (preserves literal types, enables better inference)
   - 5.6 [Use Exhaustive Checks for Union Types](references/safety-exhaustive-checks.md) — MEDIUM-HIGH (prevents 100% of missing case errors at compile time)
   - 5.7 [Use Type Guards for Runtime Type Checking](references/safety-use-type-guards.md) — MEDIUM-HIGH (eliminates type assertions, catches errors at boundaries)
6. [Memory Management](references/_sections.md#6-memory-management) — **MEDIUM**
   - 6.1 [Avoid Closure Memory Leaks](references/mem-avoid-closure-leaks.md) — MEDIUM (prevents retained references in long-lived callbacks)
   - 6.2 [Avoid Global State Accumulation](references/mem-avoid-global-state.md) — MEDIUM (prevents unbounded memory growth)
   - 6.3 [Clean Up Event Listeners](references/mem-cleanup-event-listeners.md) — MEDIUM (prevents unbounded memory growth)
   - 6.4 [Clear Timers and Intervals](references/mem-clear-timers.md) — MEDIUM (prevents callback retention and repeated execution)
   - 6.5 [Use WeakMap for Object Metadata](references/mem-use-weakmap-for-metadata.md) — MEDIUM (prevents memory leaks, enables automatic cleanup)
7. [Runtime Optimization](references/_sections.md#7-runtime-optimization) — **LOW-MEDIUM**
   - 7.1 [Avoid Object Spread in Hot Loops](references/runtime-avoid-object-spread-in-loops.md) — LOW-MEDIUM (reduces object allocations by N×)
   - 7.2 [Cache Property Access in Loops](references/runtime-cache-property-access.md) — LOW-MEDIUM (reduces property lookups by N× in hot paths)
   - 7.3 [Prefer Native Array Methods Over Lodash](references/runtime-prefer-array-methods.md) — LOW-MEDIUM (eliminates library overhead, enables tree-shaking)
   - 7.4 [Use for-of for Simple Iteration](references/runtime-use-for-of-for-iteration.md) — LOW-MEDIUM (reduces iteration boilerplate by 30-50%)
   - 7.5 [Use Modern String Methods](references/runtime-use-string-methods.md) — LOW-MEDIUM (2-5× faster than regex for simple patterns)
   - 7.6 [Use Set/Map for O(1) Lookups](references/runtime-use-set-for-lookups.md) — LOW-MEDIUM (O(n) to O(1) per lookup)
8. [Advanced Patterns](references/_sections.md#8-advanced-patterns) — **LOW**
   - 8.1 [Use Branded Types for Type-Safe IDs](references/advanced-branded-types.md) — LOW (prevents mixing incompatible ID types)
   - 8.2 [Use satisfies for Type Validation with Inference](references/advanced-satisfies-operator.md) — LOW (prevents property access errors, enables 100% autocomplete accuracy)
   - 8.3 [Use Template Literal Types for String Patterns](references/advanced-template-literal-types.md) — LOW (prevents 100% of string format errors at compile time)

## References

1. [https://github.com/microsoft/TypeScript/wiki/Performance](https://github.com/microsoft/TypeScript/wiki/Performance)
2. [https://www.typescriptlang.org/docs/handbook/](https://www.typescriptlang.org/docs/handbook/)
3. [https://v8.dev/blog](https://v8.dev/blog)
4. [https://nodejs.org/en/learn/diagnostics/memory](https://nodejs.org/en/learn/diagnostics/memory)
