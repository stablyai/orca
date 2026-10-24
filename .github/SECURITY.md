# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Report them privately through GitHub instead:
[**Security → Report a vulnerability**](https://github.com/stablyai/orca/security/advisories/new).
Only the maintainers can see the report, and you can work on the fix with them in a private fork.

Please include:

- the affected component (for example: desktop app, CLI, SSH relay, mobile pairing, runtime RPC, browser pane, agent hooks)
- the Orca version or commit, and the operating system
- steps to reproduce, or a proof of concept
- the impact: what an attacker could do, and what access they need first (local user, same network, a malicious repository, a malicious web page, a compromised SSH host)

## Scope

Orca runs agents, terminals and Git against local repositories, remote SSH hosts and paired devices. Examples of what is in scope:

- secrets or credentials (agent-hook tokens, pairing keys, Git or provider credentials) reaching a process, host or page that should not have them
- IPC or RPC trust boundaries that a renderer, web page, deep link or remote host can cross
- command or path injection through repository content, branch names, file names or deep links
- unauthenticated access to a local or network-reachable Orca service

Out of scope: vulnerabilities in third-party agent CLIs, the user's own Git or SSH binaries, or upstream dependencies, unless Orca's use of them makes the problem worse. Please report those to their maintainers.

## Supported Versions

Fixes land on `main` and ship in the next release. Please check that the issue reproduces on the latest release or on `main` before reporting.

## Disclosure

Please give the maintainers a reasonable chance to release a fix before you share details publicly. Once a fix ships, the advisory can be published with credit to the reporter if they want it.
