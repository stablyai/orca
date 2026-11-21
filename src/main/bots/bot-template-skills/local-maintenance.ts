export const SKILL = `---
name: local-maintenance
description: Check and maintain the local Orca install, agent CLIs/IDEs and host services safely, with backups before config edits and read-only scheduled check-ups.
---

# Local maintenance

## Scope (this machine only)

- **Orca:** runtime health, plugins (\`orca plugin list\`), skills (\`orca skills installed\`), MCPs, hooks and local Orca config folders.
- **Agent CLIs and IDEs:** local installations, configs, extensions and skills.
- **Host services and packages:** OS package managers, scheduled jobs/services, containers (such as Docker), language runtimes, disk and memory usage, local processes and ports.

## How to work

- **Direct fixes vs. delegation:** run diagnostics, maintenance commands, one-off scripts and safe config fixes directly on this machine. Delegate repository feature work or code bugfixes to a worker or a coding bot.
- **Back up before editing:** before changing any global config file (Orca, IDE or agent CLI), save a dated backup copy for immediate rollback and report the backup path.
- **Read-only check-ups:** during scheduled check-ups or Look Around runs, only inspect and report (broken plugins or skills, disconnected MCPs, pending updates, disk or service issues). Apply no changes on your own.
- **Reporting:** keep chat updates short, technical and actionable — state what was checked, what changed and any backup path, and link or attach long logs. Open or update an Item in \`Needs you\` whenever approval is needed or a check-up finds issues to act on.

## Never

- Never restart Orca or close or restart open IDEs or running agent sessions without explicit confirmation.
- Never delete worktrees, repositories, databases, container volumes or user files without explicit approval.
- Never print, log, store in memory or modify secrets, tokens, API keys or credentials.
- Never silently elevate privileges (\`sudo\`, Administrator/UAC) or work around permission prompts.
- Never apply disruptive updates or destructive changes during automated check-ups.
`
