# Agent skill provider paths

Last verified: 2026-08-11.

V1 supports only providers whose paths are independently established by official documentation.
The registry is deliberately small; it is not copied or synchronized from a community path table.

| Provider | Detection | Global canonical support | Workspace support | Orca placement |
| --- | --- | --- | --- | --- |
| Codex | `codex` CLI found through Orca's host-owned PATH detection | Reads `$HOME/.agents/skills` directly | Reads `.agents/skills` from the current directory through the repository root | Canonical copy only |
| Claude Code | `claude` CLI found through Orca's host-owned PATH detection | Reads `$HOME/.claude/skills` | Reads `.claude/skills` from the launch directory through the repository root, plus nested directories as files are accessed | Relative directory symlink on POSIX, directory junction on Windows, or verified independent-copy fallback |

Codex locations and symlink behavior are documented in the official OpenAI documentation:
[Build skills](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills).

Claude Code locations, precedence, parent traversal, live detection, and symlink behavior are
documented in the official Anthropic documentation:
[Extend Claude with skills](https://code.claude.com/docs/en/skills#where-skills-live).

Codex therefore needs no provider-specific placement. Claude Code does not document
`.agents/skills` as a discovery root, so Orca reconciles its documented `.claude/skills` path back
to the canonical copy. Orca never replaces a path it does not own. If alias creation is unavailable,
the verified copy fallback is tracked in the install receipt so update and removal can detect drift.

## Registry change process

Every registry change requires normal code review and all of the following evidence:

1. Link current official provider documentation for global and workspace paths.
2. Record whether the provider reads `.agents/skills` directly and its documented link behavior.
3. Verify global and folder-workspace discovery on macOS, Linux, native Windows, and WSL where the
   provider supports those platforms.
4. Exercise local, paired-runtime, and SSH host-owned path resolution.
5. Test alias denial, broken owned aliases, independent-copy drift, update, rollback, and removal.
6. Update mixed-version capability evidence if the placement contract changes.

Do not add automated upstream path-table synchronization. A provider release that changes discovery
semantics must enter through this review process.
