# Messaging and gates

Handle a whole `check` batch before the next `check`.

Groups (`@all`, `@idle`, `@codex`, ...) reach the live workers of your Run;
`@worktree:<id>` also reaches coordinators in that workspace. Use groups only
for deliberate fan-out.

To reach an agent on a paired server, use `send --on <server>`; a reply to mail
from another server needs no flag. See
[Placement and remote execution](placement-and-remote.md).
