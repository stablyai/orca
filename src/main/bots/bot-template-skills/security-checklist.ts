export const SKILL = `---
name: security-checklist
description: What to look for in a merged change for leaked secrets, injection, missing auth checks and unsafe defaults.
---

# Security check of a change

Read each merged change for the problems below. Report only what you can point to.

## Secrets

- Keys, tokens, passwords or private URLs in code, config, tests or fixtures.
- Logs or error messages that print headers, tokens, cookies or full request bodies.

## Injection

- User input reaching a shell command, SQL, a file path, HTML or a template without escaping or a fixed argument list.
- Paths built from input that could leave the intended folder (\`..\`).

## Access

- A new endpoint, command or route with no permission check, or a check that runs after the work.
- A check that trusts something the caller controls (a header, an ID in the body).

## Unsafe defaults

- Features or debug modes turned on by default, wide CORS, disabled certificate checks, world-readable files.
- New dependencies from unknown publishers, or install scripts.

## Report

- One finding per bullet with file and line, what an attacker could do, and how likely it is.
- If a secret leaked, say so first: it needs rotating, not just deleting.
- Say "nothing found" when nothing is found; don't stretch.
`
