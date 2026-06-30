# Implement the Scryer engine natively in TypeScript

The product runtime will implement Scryer model-engine semantics in Orca's TypeScript/Node codebase instead of calling a packaged Rust sidecar. Upstream Rust remains the semantic reference, but native implementation keeps packaging, UI refresh, IPC, agent runtime, and tests inside Orca.
