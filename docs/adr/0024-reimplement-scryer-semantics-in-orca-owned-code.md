# Reimplement Scryer semantics in Orca-owned code

Orca will migrate Scryer functional semantics and reimplement the code in Orca-owned TypeScript/Node modules rather than directly copying upstream implementation source into the product runtime. Upstream Scryer remains the reference for behavior, schemas, state transitions, and parity tests; Orca owns the implementation.
