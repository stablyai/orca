# Messaging and gates

Handle a whole `check` batch before the next `check`. Scripts that only watch
the inbox must use `check --peek`, which marks nothing handled.

Groups (`@all`, `@idle`, `@codex`, ...) reach the live workers of your Run;
`@worktree:<id>` also reaches coordinators in that workspace. Use groups only
for deliberate fan-out.
