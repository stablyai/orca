# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root, if it exists.
- `CONTEXT-MAP.md` at the repo root, if it exists. It points at one `CONTEXT.md` per context.
- `docs/adr/`, if it exists. Read ADRs that touch the area being changed.

If these files do not exist, proceed silently. Do not create them just because they are missing. The producer skill creates them lazily when terms or decisions are actually resolved.

## File structure

This repo currently uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term as defined in `CONTEXT.md`.

If the concept is not in the glossary yet, either reconsider the wording or note the gap for `/grill-with-docs`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly instead of silently overriding the decision.
