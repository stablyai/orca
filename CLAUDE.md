@AGENTS.md

<!-- DEVOS_CANONICAL_START -->
<!-- DevOS:section:project-context -->
## Project Context

- **Project:** orca
- **DevOS profile:** `unknown`
<!-- /DevOS:section:project-context -->

<!-- DevOS:section:conventions -->
## Development Conventions

- Check project README and CLAUDE.md for stack-specific conventions
<!-- /DevOS:section:conventions -->

<!-- DevOS:section:safety-rules -->
## Safety Rules

- Before removing or overwriting config files, create a backup first
- Never bulk-delete files without explicit approval
- Do not commit secrets (`.env`, credentials, API keys) to git
- Before staging files for a commit, verify they are inside the git repository root
- Do not force-push to main/master
- Run tests before claiming a fix works
<!-- /DevOS:section:safety-rules -->

<!-- DevOS:section:directory-structure -->
## Key Directories

- `src/` — source code
- `tests/` — test files
- `docs/` — documentation
<!-- /DevOS:section:directory-structure -->

<!-- DevOS:section:compatibility-posture -->
## Compatibility Posture

- Temporary pre-launch rule. Remove or revise when this project goes live.
- This project is not live yet and has no production customers.
- Breaking changes are acceptable if they simplify the product or close correctness gaps.
- Default to the best forward version, not backwards compatibility.
- Treat unfinished, unused, or dead code as unbuilt features.
- Prefer deletion or replacement over shims, adapters, compatibility layers, or legacy fallbacks.
- Do not add legacy shims, compatibility layers, migrations, or old-contract support unless explicitly requested.
<!-- /DevOS:section:compatibility-posture -->

<!-- DevOS:section:context-artifact-commit-policy -->
## Context Artifact Commit Policy

Context artifacts regenerated during a session — `docs/context/DEVOS_*.md`,
`docs/context/codebase-map.md`, managed blocks in `CLAUDE.md` and `AGENTS.md`,
and `product/runtime/state.yml` — must NOT be committed as standalone mid-session
commits. Stage them with `git add` and move on. The `session-end-context-commit`
Stop hook batches all pending context files into a single `chore(context)` commit
at session close. Exception: `merge-feature` cleanup commits may include context
artifacts as part of their post-merge batch.
<!-- /DevOS:section:context-artifact-commit-policy -->
<!-- DEVOS_CANONICAL_END -->
