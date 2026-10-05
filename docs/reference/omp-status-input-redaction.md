# Pi/OMP status tool-input redaction

Generated tool_call and tool_execution_start hooks sanitize inputs on the agent's
execution host before passing them to the existing status transport. Inputs that
reference `.ssh`, `.ssh-mcp`, `.mcp-secrets.env`, or
`.omp-backups-archive/omp-bak-keyfile` become `{ redacted: true }`. Matching includes
nested values, property names, Windows separators, case variants and shell token
boundaries. Sibling names such as `.ssh-backup` remain ordinary data.

The sanitizer copies data descriptors into objects without prototypes. It never
passes the source object's toJSON or getters to the transport. Cycles, accessors,
class instances, symbols, functions and non-JSON primitives redact the whole input.
Repeated ordinary object references are allowed. Depth, visited values, reserved
array slots (including holes) and inspected text have conservative bounds to avoid
moving unbounded work into synchronous JSON serialization.

This policy targets credential-path references in status tool inputs. It does not
scan transcript files, tool outputs, prompts or arbitrary secret values, and does
not erase previously persisted status. Proxy reflection traps can still run when
JavaScript inspects a proxy; the sanitizer is not an isolation boundary against a
malicious extension in the same process.

Ordinary question envelopes and preview input shapes remain unchanged. Older
clients already accept object-valued tool_input; no RPC fields or opcodes change.
The same generated code runs on local, WSL and SSH agent hosts; no local filesystem
lookup or substitution is introduced. Folder workspaces require no special path.

This follows PR #9554's credential-reference policy, with descriptor copying and
bounded serialization correcting its validation-then-original-object approach.

Run the actual OMP loader/native HTTP smoke with a read-only checkout:

```sh
ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-status-input-redaction-smoke.mjs /path/to/oh-my-pi
```

It loads Orca's generated extension through OMP, invokes synthetic tool events,
and inspects three real loopback HTTP payloads. Home/config/data roots are
disposable; it makes no model requests and does not claim an interactive tool run.
