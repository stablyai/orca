# Agent profile discovery

Converts explicit CLI home assignments into connection data for a host-detected executable.

- `command.ts`: literal command parsing with folder fallback for unsupported shell syntax.
- `command.test.ts`: provider-independent parsing and shell-boundary regressions.
- `literal-alias.ts`: discovery from bounded files containing only literal alias declarations and comments.
- `existing-home.ts`: read-only canonicalization of an existing absolute directory path.

Command tokenization is shared with `../../shared/commit-message-prompt.ts`. The caller owns
executable detection, profile persistence and provider authentication.

Alias discovery returns a candidate found in the supplied text. The caller owns reading the
appropriate host files and presenting the source; this does not prove the alias is active in an
already-open shell. Shell setup, functions, conditions and sourced files require folder selection.

Directory validation is a filesystem observation. The caller revalidates at save/launch and owns
authentication inspection; a readable path alone does not identify or verify an account.
