# Test anti-patterns

Tests that:

- Reimplement production logic instead of exercising it.
- Have no meaningful assertions, such as `expect(true).toBe(true)`.
- Assert only mock calls or values supplied by their own mocks.
- Promise inputs or behavior their setup never exercises.
- Duplicate coverage without faster feedback or clearer failures, including private predicates and provider replays.
- Copy inventories, manifests, exports, imports, or strings instead of proving behavior.
- Check persistence at a path the code never writes.
- Assert capability flags instead of delivery or acknowledgement.
- Pass negative cases without exercising the intended rejection path.
- Wait on real time or networks instead of fake clocks and deterministic boundaries.

Mocks and fixtures that:

- Hide incorrect tables, fields, joins, filters, or arguments behind mocked internal chains.
- Contradict real producers or source contracts.
- Implement the behavior under test or treat distinct APIs as equivalent.
- Supply receipts, admission decisions, callback ordering, or other outputs production code should generate.

Production code that:

- Adds exports, globals, wrappers, or code paths solely for tests.
