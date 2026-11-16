# Test anti-patterns

Keep a test only if it fails when your change is reverted, its expected values are hardcoded (not computed by production code), it lives at the one cheapest layer that owns the behavior, and its size matches the change (a one-line fix gets about one case).

Tests that:

- Reimplement production logic, or use it as the oracle (`expect(out).toBe(buildX(input))`).
- Assemble production pieces (pipelines, adapters, subclasses) instead of calling the real entry point.
- Assert nothing meaningful: `expect(true)`, lone `toBeDefined()`, `expect(a || b)`, `.not.toBe('')`, unpinned `toThrow()`, `not.toHaveBeenCalled()` on unreachable spies.
- Assert only mock calls, mock-supplied values, or fixtures the test built; or check `mock.calls[i][j]` when order doesn't matter.
- Promise inputs or behavior the setup never exercises, including unread fields and scale params (`it.each([1_000, 10_000])`) that change nothing.
- Claim pixel, layout, or interaction coverage from static markup, happy-dom/jsdom, or Tailwind/`data-slot` class strings.
- Re-test one contract per layer (shared/IPC/renderer/mobile/CLI), per desktop+mobile copy, or per locale/agent.
- Use Cartesian `it.each`, or branch inside a parameterized body, instead of one case per distinct behavior.
- Copy inventories, manifests, exports, strings, registry lists, or counts (`registry.size).toBe(50)`).
- Assert copy or translations (`changeLanguage('es')` + `getByText`, `key.replace('{{x}}', …)`).
- Pin constants, defaults, versions, or schema values.
- Test third-party behavior (Radix focus, zustand selectors, zod, i18next).
- Count internal work (`String.prototype` spies, getter/Proxy counts, read budgets) or assert wall-clock timing. Perf changes get correctness tests only.
- Reach into private state (`obj['x']`, `*ForTests()`, test-only subclasses).
- Check persistence at a path the code never writes, or capability flags instead of delivery.
- Wait on real time or networks instead of fake clocks.

Mocks and fixtures that:

- Fake React hooks while ignoring effect deps or cleanup.
- Hide wrong tables, fields, joins, filters, or arguments behind mocked internal chains.
- Contradict real producers (e.g. mocking a feature gate back to old logic).
- Implement the behavior under test (e.g. a mocked lock that sets the state it guards), or supply outputs production should generate.
- Are hand-copied across files instead of extending a shared typed fake.

Production code that adds exports, globals, wrappers, dependency overrides, or code paths only for tests.
