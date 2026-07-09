# Wiki generation contract

You are generating a repository wiki into the `.wiki/` folder at the root of the current
repository. Work only inside `.wiki/`; treat the rest of the repo as read-only reference.

Rules:
- Facts come from the code on the current default branch. Mark anything reconstructed
  indirectly with ⚠️.
- Write all prose in English; identifiers (paths, tables, services, fields) exactly as in code.
- Prefer tables over narrative. One note = one responsibility.
- Create the root overview note as `.wiki/Home.md` — it MUST contain a "Note map" table
  linking every other note and a "Where in code" table.
- Repository wiki layout (adapt to the repo; skip sections that do not apply):
  - `.wiki/Home.md` — overview, note map, where-in-code, commands.
  - `.wiki/<repo> — Architecture.md`, `— Data.md`, `— Interfaces.md`.
  - `.wiki/Business logic/<Feature>.md` — one note per feature (frontmatter `code:` list).
  - `.wiki/Services/<service>.md` — only for monorepos.
- Cross-link notes with **relative Markdown links** so the in-app wiki viewer can follow them,
  e.g. `[Sub note](./Business logic/Feature.md)` or `[Overview](./Home.md)`. Paths are relative
  to the linking note and must point at real `.md` files inside `.wiki/`. Do NOT use
  `[[Basename]]` wikilinks — the viewer renders those as plain text, not clickable links.
- Do not put page tags in a way that's meant to be read as body text — frontmatter tags are
  fine (the viewer hides frontmatter), but keep them in YAML frontmatter, not inline.

Templates to follow are provided below. Do not copy them verbatim — use them as the structure
and frontmatter contract.
