# Orchestration parity declaration

Every `orchestration.*` RPC method has one section: what an agent caller gets, per agent kind (terminal, chat) and location. `config/scripts/static-analysis/orchestration-parity/check-orchestration-parity-declarations.mjs` fails CI when a method has no section, a section names no registered method, or a section misses a kind and location. Sections describe the code as it is; a change in behaviour updates its section.

- **Local**: the caller runs on the Orca that serves the method.
- **Paired**: the caller's CLI runs the command on a paired Orca (`--environment`).
- **SSH/WSL**: the caller runs in an SSH or WSL workspace of the serving Orca.

Each line is `supported` (or `supported: <note>`), ``refused `<code>`: <reason>``, or `n/a: <reason>`. A method whose answer is the same for both kinds everywhere may give it once, as `All`.

## `orchestration.ask`

- Terminal · Local: supported: inside a supervised Dispatch
- Chat · Local: supported: inside a supervised Dispatch
- Terminal · Paired: refused `dispatch_inactive`: the paired Orca has no Dispatch for this caller
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported: inside a supervised Dispatch
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.callerShow`

- Terminal · Local: supported: no session, so it answers no caller
- Chat · Local: supported: names the live chat session
- Terminal · Paired: supported: the paired Orca knows no session for this caller
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported: no session, so it answers no caller
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.check`

- Terminal · Local: supported
- Chat · Local: supported: refused `session_caller_not_live` while the chat is released
- Terminal · Paired: refused `stable_pane_required`: the mailbox lives on the caller's own Orca
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.crewSubscribe`

- All: n/a: the Orca app and phone call it; no agent command

## `orchestration.dispatch`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: runs on the paired Orca, which records a caller it cannot reach
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.dispatchShow`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: reads the paired Orca's own records
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.federationAck`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationAttachStart`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationFleetSnapshot`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationImport`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationPull`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationRead`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationReadOutput`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationRelease`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationRetain`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationShow`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.federationStop`

- All: n/a: a home Orca calls it on its paired Orca; no agent command

## `orchestration.gateCreate`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: runs on the paired Orca, which records a caller it cannot reach
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.gateList`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: reads the paired Orca's own records
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.gateResolve`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: runs on the paired Orca, which records a caller it cannot reach
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.inbox`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: lists the paired Orca's mail, not the caller's
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.partyLocation`

- All: n/a: the Orca app and phone call it; no agent command

## `orchestration.partyOpen`

- All: n/a: the Orca app and phone call it; no agent command

## `orchestration.reply`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: the reply stays on the paired Orca and never reaches the caller
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.requestShow`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: reads the paired Orca's own records
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.reset`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: resets the paired Orca's orchestration state
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.run`

- All: refused `orchestration_migration_required`: retired; use `run-create` and `run-use`

## `orchestration.runCreate`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: runs on the paired Orca, which records a caller it cannot reach
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.runCurrent`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: reads the paired Orca's own records
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.runList`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: reads the paired Orca's own records
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.runShow`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: reads the paired Orca's own records
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.runStop`

- All: refused `orchestration_migration_required`: retired; use `run-create` and `run-use`

## `orchestration.runUse`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: runs on the paired Orca, which records a caller it cannot reach
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.send`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: the paired Orca stores a sender it cannot reach, so replies never come back
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.sessionAddress`

- All: n/a: the Orca app and phone call it; no agent command

## `orchestration.taskCreate`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: runs on the paired Orca, which records a caller it cannot reach
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.taskList`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: reads the paired Orca's own records
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.taskUpdate`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: runs on the paired Orca, which records a caller it cannot reach
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerAbandon`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: acts on the paired Orca's own workers
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerAutoClose`

- All: n/a: the Orca app and phone call it; no agent command

## `orchestration.workerChatTouch`

- All: n/a: the Orca app and phone call it; no agent command

## `orchestration.workerKeepOpen`

- All: n/a: the Orca app and phone call it; no agent command

## `orchestration.workerList`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: reads the paired Orca's own records
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerRead`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: acts on the paired Orca's own workers
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerRelease`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: acts on the paired Orca's own workers
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerRetain`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: acts on the paired Orca's own workers
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerShow`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: acts on the paired Orca's own workers
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerStart`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: `--on` starts it from the caller's own Orca and reports come home
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca; `--on` starts it from the caller's own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerStop`

- Terminal · Local: supported
- Chat · Local: supported
- Terminal · Paired: supported: acts on the paired Orca's own workers
- Chat · Paired: refused `session_caller_host_boundary`: a session id names a caller only on its own Orca
- Terminal · SSH/WSL: supported
- Chat · SSH/WSL: refused `session_caller_host_boundary`: chat agents do not run in SSH or WSL

## `orchestration.workerTerminalUserInput`

- All: n/a: the Orca app and phone call it; no agent command
