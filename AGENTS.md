# AGENTS.md

## Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow [`docs/STYLEGUIDE.md`](./docs/STYLEGUIDE.md). Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

## Code Comments: Document the "Why", Briefly

When writing or modifying code driven by a design doc or non-obvious constraint, add a comment explaining **why** the code behaves the way it does.

Keep comments short — one or two lines. Capture only the non-obvious reason (safety constraint, compatibility shim, design-doc rule). Don't restate what the code does, narrate the mechanism, cite design-doc sections verbatim, or explain adjacent API choices unless they're the point.

## Lint Rules: Do Not Disable Max Lines

Never add a `max-lines` disable (`eslint-disable max-lines`, `oxlint-disable max-lines`, or line-specific variants). Split the file, extract focused modules, move fixtures/builders into named files, or otherwise reduce the counted lines instead.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero information and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.

## SSH Use Case

All changes must consider the SSH use case. Don't assume local-only execution.

## Git Provider Compatibility

Source-control and review changes must consider GitLab and other supported git providers, not only GitHub. Keep provider-specific behavior behind explicit checks, and avoid GitHub-only naming for generic review concepts.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.
Never commit PR evidence images; attach them to the PR conversation instead.

## Type Declarations: Prefer `.ts` Over `.d.ts`

Project-owned type declarations belong in `.ts` files. `.d.ts` is reserved for ambient shims (e.g., `env.d.ts`, `vite/client.d.ts`). TypeScript's `skipLibCheck: true` setting applies globally, including to our own `.d.ts` files, which means any unresolved type reference in a `.d.ts` silently becomes `any` at its call sites. Write your types in `.ts` files so the compiler actually checks them. CI enforces this for `src/preload/` and `src/shared/` — see `docs/preload-typecheck-hole.md`.

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
- `product/` — specs, planning, runtime (DevOS managed)
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

<!-- DEVOS_AUTO_START -->


## claude-code-core

Claude Code Settings & Configuration (May 2026)

SCOPE HIERARCHY (highest→lowest): managed > CLI args > local (.claude/settings.local.json) > project (.claude/settings.json) > user (~/.claude/settings.json)

MANAGED LOCATIONS: macOS:/Library/Application Support/ClaudeCode/managed-settings.json | Linux:/etc/claude-code/managed-settings.json | drop-in: managed-settings.d/*.json

KEY SETTINGS: model:"claude-sonnet-4-6" | effortLevel:"xhigh" | alwaysThinkingEnabled:true | showThinkingSummaries:false
editorMode:"normal"|"vim" | tui:"fullscreen"|"default" | viewMode:"default"|"verbose"|"focus"
autoMemoryEnabled:true | claudeMd:"instructions..." | claudeMdExcludes:["**/vendor/**/CLAUDE.md"]

PERMISSIONS: {"permissions":{"allow":["Bash(npm run *)","Read(~/.zshrc)"],"deny":["Bash(curl *)","Read(./.env)"],"ask":["Bash(git push *)"],"defaultMode":"acceptEdits","additionalDirectories":["../docs/"]}}
Rule syntax: Tool | Tool(specifier) | Read(path) | Edit(path) | Bash(cmd) | WebFetch(domain:x.com) | Agent(name)
Evaluation: deny → ask → allow (first match wins)

SANDBOX: {"sandbox":{"enabled":true,"failIfUnavailable":true,"filesystem":{"allowWrite":["/tmp"],"denyRead":["~/.aws/credentials"]},"network":{"allowedDomains":["github.com"],"allowLocalBinding":true}}}

SKILLS: skillListingBudgetFraction:0.01 | maxSkillDescriptionChars:1536 | skillOverrides:{"deploy":"off"} | disableSkillShellExecution:false

MEMORY FILES: .claude/CLAUDE.md (project) | ~/.claude/CLAUDE.md (user) | CLAUDE.local.md (local, gitignored)

CLI FLAGS: --model | --max-turns N | --output-format json|text|stream-json | --print/-p (headless) | --verbose | --debug | --allowedTools | --disallowedTools | --append-system-prompt | --mcp-config

SLASH COMMANDS: /help /clear /config /compact /memory /doctor /hooks /mcp /review /init /bug /fast

ENV VARS: ANTHROPIC_MODEL | CLAUDE_CODE_EFFORT_LEVEL | CLAUDE_CODE_DISABLE_THINKING | DISABLE_AUTOUPDATER | CLAUDE_CODE_AUTO_CONNECT_IDE

WORKTREE: {"worktree":{"baseRef":"fresh","symlinkDirectories":["node_modules"],"sparsePaths":["packages/my-app"]}}

ATTRIBUTION: {"attribution":{"commit":"Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"}}
SCHEMA: "$schema":"https://json.schemastore.org/claude-code-settings.json"
CONFIG CLI: claude /config (interactive REPL) | auto backups, retains 5 most recent


## claude-code-extensions

Claude Code Hooks, Skills & MCP (May 2026)

HOOK TYPES: command | http | mcp_tool | prompt | agent
command: {"type":"command","command":"/path/script.sh","args":["arg1"],"async":false}
http: {"type":"http","url":"http://localhost:8080/hook","headers":{"Authorization":"Bearer $TOKEN"},"allowedEnvVars":["TOKEN"]}
mcp_tool: {"type":"mcp_tool","server":"my_server","tool":"security_scan","input":{}}
prompt: {"type":"prompt","prompt":"Should this run? $ARGUMENTS","model":"claude-opus-4-1"}
agent: {"type":"agent","prompt":"Verify safety. Context: $ARGUMENTS"}

COMMON FIELDS: if (permission rule filter) | timeout (sec, default 600; 30 for prompt) | statusMessage | once (bool)

EXIT CODES: 0=success+parse JSON | 2=BLOCKING (stops action) | 1/3+=non-blocking (logged)

JSON OUTPUT:
{"continue":true,"stopReason":"...","suppressOutput":false,"systemMessage":"...","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"...","permissionDecision":"deny|allow|ask|defer","permissionDecisionReason":"...","modifiedInput":{}}}

HOOK EVENTS:
Per-session: SessionStart(startup|resume|clear|compact), SessionEnd, Setup
Per-turn: UserPromptSubmit(30s timeout, BLOCKS), Stop(BLOCKS), StopFailure, UserPromptExpansion(BLOCKS)
Per-tool: PreToolUse(BLOCKS), PostToolUse, PostToolUseFailure, PermissionRequest(BLOCKS), PermissionDenied, PostToolBatch(BLOCKS)
Async: WorktreeCreate(BLOCKS), WorktreeRemove, Notification, ConfigChange(BLOCKS), InstructionsLoaded, CwdChanged, FileChanged, PreCompact(BLOCKS), PostCompact, Elicitation(BLOCKS), ElicitationResult(BLOCKS), SubagentStart, SubagentStop(BLOCKS)

SESSIONSTART: input:{source:"startup|resume|clear|compact",model:"..."} | env:echo "export K=V" >> "$CLAUDE_ENV_FILE"
SESSIONSTART CONTROL: {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Branch: main"}}

PRETOOLUSE BASH INPUT: {"tool_name":"Bash","tool_input":{"command":"rm -rf /tmp","description":"...","timeout":120000},"tool_use_id":"..."}
PRETOOLUSE CONTROL: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}

MATCHERS: "*"="" = match all | letters/digits/_/| = exact/list e.g."Edit|Write" | other chars = regex e.g."mcp__memory__.*"

ENV VARS: $CLAUDE_PROJECT_DIR | $CLAUDE_PLUGIN_ROOT | $CLAUDE_PLUGIN_DATA | $CLAUDE_EFFORT | $CLAUDE_ENV_FILE | $CLAUDE_CODE_REMOTE

MCP CONFIG:
~/.claude.json: {"mcpServers":{"name":{"type":"stdio","command":"npx","args":["-y","pkg"],"env":{}}}}
.mcp.json: project-level (shared via git)
Transport: stdio | http (remote) | sse (legacy)
Tool names in hooks/perms: mcp__<server>__<tool>

SKILLS: location .claude/skills/<name>/SKILL.md | ~/.claude/skills/<name>/SKILL.md
Invocation: /<skill-name> [args] | frontmatter: hooks, permissions, environment
Discovery: claude /skills

SUBAGENTS: location .claude/agents/<name>.md | ~/.claude/agents/<name>.md
Frontmatter: name, description, model, tools, permissions
Spawn: Agent({description, prompt, subagent_type})
Types: claude (catch-all) | Explore (read-only search) | Plan (architect) | general-purpose


## claude-code-automation

Claude Code Automation & GitHub Actions (May 2026)

HEADLESS MODE: claude -p "prompt" [flags]
Key flags: --output-format json|text|stream-json | --max-turns N | --model name | --allowedTools t1,t2 | --disallowedTools t1 | --append-system-prompt "text" | --mcp-config path | --debug
Exit: 0=success | 1=error | 2=usage error
Stream JSON events: {"type":"text","content":"..."} | {"type":"tool_use",...} | {"type":"result","exit_code":0}

GITHUB ACTIONS v1 (GA, 2026):
Action: anthropics/claude-code-action@v1
Params: prompt(str) | claude_args(str, CLI passthrough) | anthropic_api_key(req) | github_token | trigger_phrase(default "@claude") | use_bedrock | use_vertex | plugin_marketplaces | plugins

BASIC WORKFLOW:
name: Claude Code
on: {issue_comment:{types:[created]}, pull_request_review_comment:{types:[created]}}
jobs:
  claude:
    runs-on: ubuntu-latest
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

BREAKING CHANGES from beta: mode removed (auto-detected) | direct_prompt→prompt | custom_instructions→claude_args --append-system-prompt | max_turns→claude_args --max-turns | model→claude_args --model | allowed_tools→claude_args --allowedTools

BEDROCK: with: {use_bedrock:"true", claude_args:"--model us.anthropic.claude-sonnet-4-6 --max-turns 10"}
Setup: AWS OIDC IdP + IAM role (AmazonBedrockFullAccess) + secret AWS_ROLE_TO_ASSUME
Model prefix: us.anthropic.claude-sonnet-4-6

VERTEX: with: {use_vertex:"true", claude_args:"--model claude-sonnet-4-5@20250929 --max-turns 10"}
env: {ANTHROPIC_VERTEX_PROJECT_ID:..., CLOUD_ML_REGION:us-east5}
Setup: Workload Identity Federation + service account (Vertex AI User) + secrets GCP_WORKLOAD_IDENTITY_PROVIDER, GCP_SERVICE_ACCOUNT

SETUP: /install-github-app (interactive) OR manual: install github.com/apps/claude + ANTHROPIC_API_KEY secret + copy examples/claude.yml

SKILL INVOCATION IN CI:
- uses: actions/checkout@v4
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    plugin_marketplaces: "https://github.com/anthropics/claude-code.git"
    plugins: "code-review@claude-code-plugins"
    prompt: "/code-review:code-review ${{ github.repository }}/pull/${{ github.event.pull_request.number }}"

AGENT SDK: programmatic Claude Code integration
import anthropic; client = anthropic.Anthropic()
response = client.messages.create(model="claude-sonnet-4-6", max_tokens=8096, messages=[...])

BEST PRACTICES: CLAUDE.md for project standards | --max-turns to limit runaway | GitHub concurrency controls | Never commit API keys | timeout workflows | specific @claude commands reduce API calls

COST: GitHub runner minutes (GitHub billing) + Claude API tokens (per interaction, varies by task complexity)


## claude-code-config

Claude Code Model Config, MCP & Advanced Features (May 2026)

MODELS (May 2026):
claude-sonnet-4-6 (alias: sonnet) — default
claude-opus-4-7 (alias: opus) — most capable
claude-haiku-4-5-20251001 (alias: haiku) — fastest
Set: model:"claude-sonnet-4-6" in settings.json OR ANTHROPIC_MODEL env var OR --model CLI flag

MODEL SETTINGS: effortLevel:"xhigh" | alwaysThinkingEnabled:true | showThinkingSummaries:false
modelOverrides:{"claude-opus-4-6":"arn:aws:bedrock:..."} | availableModels:["sonnet","haiku"]

FAST MODE: fastModePerSessionOptIn:true | toggle /fast in session (Opus with faster output)

OUTPUT STYLES: outputStyle:"Default"|"Explanatory"|"Minimal"|"Concise"
viewMode:"default"|"verbose"|"focus" | tui:"default"|"fullscreen" | editorMode:"normal"|"vim"
syntaxHighlightingDisabled:false | prefersReducedMotion:false | showTurnDuration:true

KEYBINDINGS (~/.claude/keybindings.json):
{"bindings":[{"keys":"ctrl+s","action":"submit"},{"keys":"ctrl+k","action":"clear"}]}
Chord: {"keys":"ctrl+x ctrl+s","action":"save"}

STATUS LINE: configure in settings.json
{"statusLine":{"enabled":true,"format":"[{model}] {context}/{maxContext} | {provider}"}}
Tokens: {model} {provider} {context} {maxContext} {effortLevel} {mode}

SANDBOXING:
{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"excludedCommands":["docker *"],"filesystem":{"allowWrite":["/tmp/build","~/.kube"],"denyWrite":["/etc"],"denyRead":["~/.aws/credentials"],"allowRead":["."]},"network":{"allowedDomains":["github.com","*.npmjs.org"],"allowLocalBinding":true,"allowAllUnixSockets":false}}}
Path prefixes: /path=absolute | ~/path=home-relative | ./path=project-relative

MCP SERVER CONFIGURATION:
~/.claude.json (user-global): {"mcpServers":{"name":{"type":"stdio","command":"npx","args":["-y","pkg"],"env":{"API_KEY":"..."},"timeout":30}}}
.mcp.json (project, shared): same format
Transport: "stdio" (subprocess, default) | "http" (remote URL) | "sse" (legacy)

MCP ADD: claude mcp add <name> -- <command> [args]
claude mcp add -s user my-server -- npx -y my-server    # user scope
claude mcp add --transport http my-remote http://localhost:3000/mcp
claude mcp list | claude mcp remove <name>

REMOTE MCP: {"type":"http","url":"https://mcp.example.com/sse","headers":{"Authorization":"Bearer $TOKEN"}}

MCP TOOL NAMES in perms: mcp__<server>__<tool>
MCP ALLOW: "permissions":{"allow":["mcp__memory__.*"]}

CHECKPOINTING: auto before destructive ops | claude --resume <session-id> to restore
COMPACTION: /compact (manual) | auto near context limit
PreCompact/PostCompact hooks available

AUTO MODE: {"autoMode":{"allow":[],"soft_deny":["$defaults","Never run terraform apply"],"hard_deny":[]}}
disableAutoMode:"disable" | useAutoModeDuringPlan:true

TELEMETRY: {"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1","OTEL_METRICS_EXPORTER":"otlp","OTEL_EXPORTER_OTLP_ENDPOINT":"http://localhost:4317"}}
otelHeadersHelper:"/bin/generate_otel_headers.sh"

MANAGED-ONLY: allowManagedPermissionRulesOnly | allowManagedMcpServersOnly | allowManagedHooksOnly | forceRemoteSettingsRefresh | policyHelper


## github-rest-api

# GitHub REST API — 2026-05

Source: docs.github.com/en/rest (live scrape), github/rest-api-description OpenAPI spec

## Auth & Base URL

**Base URL:** `https://api.github.com`

**Required headers on every request:**
```http
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
User-Agent: <your-app-name>     # REQUIRED — requests without UA are rejected
Authorization: Bearer <TOKEN>   # for authenticated requests
```

### Authentication Methods

| Method | Header | Best For |
|--------|--------|----------|
| Personal Access Token (PAT) | `Authorization: Bearer ghp_...` | Personal tooling |
| Fine-grained PAT | `Authorization: Bearer github_pat_...` | Scoped repo access |
| GitHub App installation token | `Authorization: Bearer <installation_token>` | Production apps |
| GitHub App JWT | `Authorization: Bearer <JWT>` | App-to-GitHub auth |
| OAuth token | `Authorization: Bearer <oauth_token>` | Third-party apps |
| `GITHUB_TOKEN` (Actions) | `Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}` | CI/CD workflows |

**Note:** Fine-grained PATs require both repository access permission AND the specific permission for the operation.

## Rate Limits

| Auth Method | Primary Limit | Notes |
|-------------|--------------|-------|
| Unauthenticated | 60 req/hour | Per IP |
| PAT (personal) | 5,000 req/hour | Per user |
| GitHub App (non-Enterprise) | 5,000–12,500 req/hour | Scales with repos/users |
| GitHub App (Enterprise Cloud) | 15,000 req/hour | |
| OAuth App (Enterprise Cloud) | 15,000 req/hour | |
| GITHUB_TOKEN (Actions) | 1,000 req/hour | Per repository |
| GITHUB_TOKEN (Actions, Enterprise) | 15,000 req/hour | Per repository |

**Secondary rate limits:**

| Constraint | Limit |
|-----------|-------|
| Concurrent requests | 100 max |
| REST points per minute | 900 |
| CPU time | 90 sec per 60 sec real time |
| Content creation | 80 req/min, 500/hour |
| OAuth token requests | 2,000/hour |

**Point values:** GET/HEAD/OPTIONS = 1pt, POST/PATCH/PUT/DELETE = 5pt

**Rate limit headers:**

| Header | Meaning |
|--------|---------|
| `x-ratelimit-limit` | Max requests per window |
| `x-ratelimit-remaining` | Remaining in current window |
| `x-ratelimit-used` | Used in current window |
| `x-ratelimit-reset` | Reset time (UTC epoch seconds) |
| `x-ratelimit-resource` | Which limit bucket applied |
| `retry-after` | Seconds to wait (secondary limits) |

**Check limits:** `GET /rate_limit` (doesn't count toward primary limit).

## Core Endpoints (by Resource)

### Repositories

| Method | Path | Key Params | Notes |
|--------|------|------------|-------|
| GET | `/repos/{owner}/{repo}` | owner, repo | Get repo details |
| POST | `/user/repos` | name* | Create user repo |
| POST | `/orgs/{org}/repos` | org*, name* | Create org repo |
| PATCH | `/repos/{owner}/{repo}` | owner*, repo* | Update repo settings |
| DELETE | `/repos/{owner}/{repo}` | owner*, repo* | Delete repo |
| GET | `/user/repos` | visibility, affiliation, type, sort, per_page, page | List authenticated user's repos |
| GET | `/orgs/{org}/repos` | org*, type, sort, per_page, page | List org repos |
| GET | `/repositories` | since | List all public repos |
| POST | `/repos/{template_owner}/{template_repo}/generate` | name* | Create from template |
| POST | `/repos/{owner}/{repo}/transfer` | new_owner* | Transfer ownership |

**Create repo body params:** `name`*, `description`, `private` (bool), `auto_init`, `gitignore_template`, `license_template`, `has_issues`, `has_wiki`, `has_projects`, `allow_squash_merge`, `allow_merge_commit`, `allow_rebase_merge`, `delete_branch_on_merge`

### Repository Contents

| Method | Path | Key Params | Notes |
|--------|------|------------|-------|
| GET | `/repos/{owner}/{repo}/contents/{path}` | ref (branch/tag/SHA) | Get file/dir contents |
| PUT | `/repos/{owner}/{repo}/contents/{path}` | message*, content* (base64), sha* (update only) | Create or update file |
| DELETE | `/repos/{owner}/{repo}/contents/{path}` | message*, sha* | Delete file |
| GET | `/repos/{owner}/{repo}/readme` | ref | Get root README |
| GET | `/repos/{owner}/{repo}/readme/{dir}` | ref | Get dir README |
| GET | `/repos/{owner}/{repo}/tarball/{ref}` | — | Download tar archive |
| GET | `/repos/{owner}/{repo}/zipball/{ref}` | — | Download zip archive |

**File response:** `type`, `name`, `path`, `sha`, `size`, `content` (base64), `encoding`, `url`, `html_url`, `download_url`, `_links`
**Directory response:** array of file objects (no `content` field — fetch individually)

### Search

| Method | Path | Key Params | Rate Limit |
|--------|------|------------|------------|
| GET | `/search/repositories` | q*, sort, order, per_page (max 100), page | 30/min auth, 10/min unauth |
| GET | `/search/code` | q*, sort, order, per_page, page | 9/min (all) |
| GET | `/search/issues` | q*, sort, order, per_page, page | 30/min auth |
| GET | `/search/commits` | q*, sort, order, per_page, page | 30/min auth |
| GET | `/search/users` | q*, sort, order, per_page, page | 30/min auth |
| GET | `/search/topics` | q*, per_page, page | 30/min auth |
| GET | `/search/labels` | repository_id*, q*, sort, order, per_page, page | 30/min auth |

**Search query qualifiers (repos):** `language:`, `stars:>N`, `forks:>N`, `user:`, `org:`, `topic:`, `is:public/private`, `created:`, `pushed:`

**Search query qualifiers (code):** `in:file`, `repo:owner/repo`, `language:`, `extension:`, `path:`, `filename:`

**Max results per search:** 1,000 items total (paginated); code search up to 4,000 repos

**Text match metadata:** add `Accept: application/vnd.github.text-match+json` header

**Semantic search (issues only):** `search_type=semantic` or `hybrid` — authenticated requests only

### Issues

| Method | Path | Key Params |
|--------|------|------------|
| GET | `/issues` | filter, state, labels, sort, direction, since, per_page, page |
| GET | `/orgs/{org}/issues` | org*, + same as above |
| GET | `/repos/{owner}/{repo}/issues` | milestone, state, assignee, creator, mentioned, labels, sort, direction, since, per_page, page |
| POST | `/repos/{owner}/{repo}/issues` | title* + body, milestone, labels, assignees |
| GET | `/repos/{owner}/{repo}/issues/{issue_number}` | — |
| PATCH | `/repos/{owner}/{repo}/issues/{issue_number}` | title, body, state, state_reason, milestone, labels, assignees |
| PUT | `/repos/{owner}/{repo}/issues/{issue_number}/lock` | lock_reason |
| DELETE | `/repos/{owner}/{repo}/issues/{issue_number}/lock` | — |
| GET | `/user/issues` | filter, state, sort, per_page, page |

**state values:** `open` (default) | `closed` | `all`
**filter values:** `assigned` (default) | `created` | `mentioned` | `subscribed` | `repos` | `all`

### Pull Requests

| Method | Path | Key Params |
|--------|------|------------|
| GET | `/repos/{owner}/{repo}/pulls` | state, head, base, sort, direction, per_page, page |
| POST | `/repos/{owner}/{repo}/pulls` | title*, head*, base*, body, draft, maintainer_can_modify |
| GET | `/repos/{owner}/{repo}/pulls/{pull_number}` | — |
| PATCH | `/repos/{owner}/{repo}/pulls/{pull_number}` | title, body, state, base, maintainer_can_modify |
| GET | `/repos/{owner}/{repo}/pulls/{pull_number}/files` | per_page, page |
| GET | `/repos/{owner}/{repo}/pulls/{pull_number}/reviews` | per_page, page |
| POST | `/repos/{owner}/{repo}/pulls/{pull_number}/reviews` | body, event, comments[] |
| PUT | `/repos/{owner}/{repo}/pulls/{pull_number}/merge` | merge_method (merge/squash/rebase) |

### Git Objects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/repos/{owner}/{repo}/git/blobs/{sha}` | Get blob |
| POST | `/repos/{owner}/{repo}/git/blobs` | Create blob |
| GET | `/repos/{owner}/{repo}/git/commits/{sha}` | Get commit |
| POST | `/repos/{owner}/{repo}/git/commits` | Create commit |
| GET | `/repos/{owner}/{repo}/git/refs` | List references |
| POST | `/repos/{owner}/{repo}/git/refs` | Create ref |
| PATCH | `/repos/{owner}/{repo}/git/refs/{ref}` | Update ref |
| DELETE | `/repos/{owner}/{repo}/git/refs/{ref}` | Delete ref |
| GET | `/repos/{owner}/{repo}/git/trees/{sha}` | Get tree (add `?recursive=1` for full tree) |
| POST | `/repos/{owner}/{repo}/git/trees` | Create tree |

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/user` | Get authenticated user |
| GET | `/users/{username}` | Get user by username |
| GET | `/user/emails` | List authenticated user emails |
| GET | `/users/{username}/repos` | List user's public repos |
| GET | `/users/{username}/followers` | List followers |
| GET | `/users/{username}/following` | List following |

### Organizations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/orgs/{org}` | Get org details |
| PATCH | `/orgs/{org}` | Update org |
| GET | `/orgs/{org}/members` | List members |
| GET | `/orgs/{org}/teams` | List teams |
| GET | `/user/orgs` | List authenticated user's orgs |

### Actions / Workflows

| Method | Path | Description |
|--------|------|-------------|
| GET | `/repos/{owner}/{repo}/actions/workflows` | List workflows |
| GET | `/repos/{owner}/{repo}/actions/runs` | List workflow runs |
| GET | `/repos/{owner}/{repo}/actions/runs/{run_id}` | Get run |
| POST | `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` | Trigger workflow |
| GET | `/repos/{owner}/{repo}/actions/artifacts` | List artifacts |
| GET | `/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` | Download artifact |
| GET | `/repos/{owner}/{repo}/actions/secrets` | List repo secrets |
| PUT | `/repos/{owner}/{repo}/actions/secrets/{secret_name}` | Create/update secret |

## Pagination

**Style:** Page-based (offset)

| Param | Default | Max | Description |
|-------|---------|-----|-------------|
| `per_page` | 30 | 100 | Items per page |
| `page` | 1 | — | Page number |

**Array params:** bracket notation — `?repository_ids[]=123&repository_ids[]=456`

**Link header:** GitHub returns `Link` header for navigation:
```
Link: <https://api.github.com/repos?page=2>; rel="next",
      <https://api.github.com/repos?page=10>; rel="last"
```
`rel` values: `next`, `prev`, `first`, `last`

**Individual vs list responses:** List endpoints return a subset of fields; fetch individual resource for complete data.

## Error Codes

| HTTP | Meaning | Notes |
|------|---------|-------|
| 200 | OK | Standard success |
| 201 | Created | Resource created |
| 204 | No Content | Successful delete |
| 301 | Moved Permanently | Resource URL changed |
| 302 | Found | Redirect |
| 304 | Not Modified | Conditional GET, use cached data |
| 400 | Bad Request | Malformed request or missing params |
| 401 | Unauthorized | Missing/invalid auth token |
| 403 | Forbidden | Valid token but no permission; also rate-limited |
| 404 | Not Found | Resource absent or private (not visible to token) |
| 409 | Conflict | SHA mismatch on file update; merge conflict |
| 410 | Gone | Resource permanently deleted |
| 422 | Unprocessable | Validation failed; check `errors[]` in body |
| 429 | Too Many Requests | Secondary rate limit |
| 451 | Unavailable for Legal Reasons | DMCA takedown |
| 500 | Internal Server Error | GitHub server error |
| 503 | Service Unavailable | GitHub maintenance |

**Error response format:**
```json
{
  "message": "Validation Failed",
  "errors": [
    { "resource": "Issue", "field": "title", "code": "missing_field" }
  ],
  "documentation_url": "https://docs.github.com/..."
}
```
**Error codes in `errors[].code`:** `missing`, `missing_field`, `invalid`, `already_exists`, `unprocessable`

## Gotchas

1. **`User-Agent` is mandatory** — omit it and get 403; must be app name or username.
2. **API version header required** — always send `X-GitHub-Api-Version: 2022-11-28`; new breaking changes ship in new versions.
3. **`Accept` header** — use `application/vnd.github+json`; `application/json` also works but may differ.
4. **File contents are base64** — `content` field in file response is base64-encoded; decode before using.
5. **`sha` required on file update** — PUT to update/delete a file requires current file SHA or you get 409.
6. **404 hides private repos** — if token lacks permission, private repos return 404 not 403.
7. **List vs individual responses** — list endpoints return abbreviated objects; get individual resource for full data.
8. **Secondary rate limits are strict** — 100 concurrent requests max; writing content (issues, PRs) limited to 80/min.
9. **Search code is restrictive** — code search: 9 req/min for everyone; only searches default branch; max 4000 repo results.
10. **Fine-grained PATs need two things** — repository access selection AND the specific permission; easy to misconfigure.
11. **Webhook events use different paths** — REST API and webhook payloads have different schemas; don't conflate them.
12. **`since` param is exclusive** — `since=2024-01-01T00:00:00Z` returns items updated AFTER that timestamp.


## linear-graphql-api

# Linear GraphQL API — 2026-05

Source: github.com/linear/linear packages/sdk/src/ (schema.graphql 1.1MB, _generated_documents.graphql)

## Auth & Base URL

**Endpoint:** `https://api.linear.app/graphql`  
**Protocol:** GraphQL over HTTPS — single POST endpoint for all operations.

### Personal API Key
```http
POST https://api.linear.app/graphql
Authorization: Bearer lin_api_<token>
Content-Type: application/json
```
Generate at: Linear Settings → API → Personal API Keys.

### OAuth 2.0
- **Authorization URL:** `https://linear.app/oauth/authorize`
- **Token URL:** `https://api.linear.app/oauth/token`
- **Scopes:** `read`, `write`, `issues:create`, `comments:create`, `timeSchedule:write`, `admin`
- **Flow:** Authorization Code; PKCE supported
- Personal API keys do not expire; OAuth tokens configurable

### Request Format
```json
{
  "query": "query issues($first: Int) { issues(first: $first) { nodes { id title } } }",
  "variables": { "first": 25 }
}
```

## Rate Limits

| Limit Type | Value | Window |
|------------|-------|--------|
| Requests | 1,500 | 1 hour |
| Complexity points | 10,000 | 1 hour |
| Burst | ~50 requests | 10 sec |

**Headers:**
- `X-RateLimit-Requests-Limit` — max requests/hour
- `X-RateLimit-Requests-Remaining` — remaining in window
- `X-RateLimit-Requests-Reset` — UTC epoch reset time
- `X-Complexity-Limit`, `X-Complexity-Remaining`

On limit exceeded: HTTP 429, retry after `Retry-After` header seconds.

## Core Operations (by Resource)

### Issues

```graphql
# Fetch one issue
query issue($id: String!) {
  issue(id: $id) {
    id identifier title description url
    state { id name type }
    assignee { id name email }
    team { id name key }
    labels { nodes { id name color } }
    priority          # 0=none 1=urgent 2=high 3=medium 4=low
    estimate
    dueDate
    createdAt updatedAt
    comments { nodes { id body user { name } } }
  }
}

# List / filter issues
query issues(
  $filter: IssueFilter
  $first: Int         # default 50, max 250
  $after: String      # cursor for next page
  $last: Int
  $before: String
  $orderBy: PaginationOrderBy  # createdAt | updatedAt
  $includeArchived: Boolean    # default false
) {
  issues {
    nodes { id identifier title priority state { name } assignee { name } }
    pageInfo { hasNextPage endCursor hasPreviousPage startCursor }
  }
}

# IssueFilter supports AND/OR nesting on:
# id, title, description, number, priority, estimate, createdAt, updatedAt,
# dueDate, completedAt, canceledAt, state, assignee, team, project,
# cycle, label, creator, parent, searchableContent

# Search issues by text
query issueSearch($term: String!, $first: Int, $after: String) {
  issueSearch(query: $term, first: $first, after: $after) {
    nodes { id title state { name } }
    pageInfo { hasNextPage endCursor }
  }
}

# Create issue
mutation createIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title url }
  }
}
# IssueCreateInput required: title, teamId
# Optional: description (markdown), descriptionData (ProseMirror),
#   assigneeId, labelIds[], stateId, priority (0-4), estimate,
#   dueDate, parentId, projectId, cycleId, subscriberIds[]

# Update issue
mutation updateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id title state { name } updatedAt }
  }
}
# IssueUpdateInput: any IssueCreateInput field is optional for partial update

# Archive issue (soft delete)
mutation archiveIssue($id: String!) {
  issueArchive(id: $id) { success }
}

# Batch create issues
mutation createIssueBatch($input: IssueBatchCreateInput!) {
  issueBatchCreate(input: $input) { success issues { id } }
}
```

### Teams

```graphql
query teams($first: Int, $after: String, $filter: TeamFilter) {
  teams {
    nodes { id name key description timezone issueCount }
    pageInfo { hasNextPage endCursor }
  }
}

query team($id: String!) {
  team(id: $id) {
    id name key
    states { nodes { id name type color position } }
    labels { nodes { id name color } }
    members { nodes { id name email } }
    cycles { nodes { id number startsAt endsAt completedAt } }
  }
}

# Team issues with filter
query team_issues($id: String!, $filter: IssueFilter, $first: Int, $after: String) {
  team(id: $id) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes { id title state { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

### Projects

```graphql
query projects($first: Int, $after: String, $filter: ProjectFilter) {
  projects {
    nodes { id name description url state status { name color } startDate targetDate }
    pageInfo { hasNextPage endCursor }
  }
}

query project($id: String!) {
  project(id: $id) {
    id name
    members { nodes { id name } }
    issues { nodes { id title } }
    milestones { nodes { id name targetDate } }
    teams { nodes { id name } }
  }
}

mutation createProject($input: ProjectCreateInput!) {
  projectCreate(input: $input) { success project { id name } }
}
# ProjectCreateInput required: name, teamIds[]
# Optional: description, state, startDate, targetDate, leadId, memberIds[]

mutation updateProject($id: String!, $input: ProjectUpdateInput!) {
  projectUpdate(id: $id, input: $input) { success }
}

mutation archiveProject($id: String!) { projectArchive(id: $id) { success } }
```

### Users

```graphql
query users($first: Int, $after: String, $filter: UserFilter, $includeArchived: Boolean) {
  users {
    nodes { id name displayName email avatarUrl active admin }
    pageInfo { hasNextPage endCursor }
  }
}

query user($id: String!) {
  user(id: $id) {
    id name email
    assignedIssues(first: 25) { nodes { id title } }
    createdIssues(first: 25) { nodes { id title } }
    teams { nodes { id name } }
  }
}

# Authenticated user
query viewer {
  viewer {
    id name email displayName
    organization { id name urlKey }
    teams { nodes { id name key } }
  }
}
```

### Labels

```graphql
query issueLabels($first: Int, $after: String, $filter: IssueLabelFilter) {
  issueLabels {
    nodes { id name color description team { id } parent { id } }
    pageInfo { hasNextPage endCursor }
  }
}

mutation createIssueLabel($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name } }
}
# IssueLabelCreateInput required: name, teamId; optional: color, description, parentId
```

### Comments

```graphql
query comment($id: String!) {
  comment(id: $id) {
    id body url
    issue { id title }
    user { id name }
    parent { id }
    children { nodes { id body } }
    createdAt updatedAt
  }
}

query comments($filter: CommentFilter, $first: Int, $after: String) {
  comments {
    nodes { id body issueId userId createdAt }
    pageInfo { hasNextPage endCursor }
  }
}

mutation createComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body } }
}
# CommentCreateInput required: issueId, body (markdown)
# Optional: parentId (for threaded replies)

mutation commentResolve($id: String!) { commentResolve(id: $id) { success } }
mutation commentUnresolve($id: String!) { commentUnresolve(id: $id) { success } }
```

### Attachments

```graphql
query attachment($id: String!) {
  attachment(id: $id) { id title subtitle url iconUrl issue { id } metadata }
}

mutation createAttachment($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id } }
}
# AttachmentCreateInput required: issueId, url, title
# Optional: subtitle, iconUrl, metadata (JSON)

# Link external resources
mutation attachmentLinkURL($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success attachment { id } }
}
# Also: attachmentLinkGitHubPR, attachmentLinkGitHubIssue,
#        attachmentLinkSlack, attachmentLinkJiraIssue, etc.
```

### Workflow States

```graphql
query workflowStates($filter: WorkflowStateFilter, $first: Int, $after: String) {
  workflowStates {
    nodes { id name type color position team { id } }
    pageInfo { hasNextPage endCursor }
  }
}
# state type values: triage | backlog | unstarted | started | completed | cancelled
```

### Cycles

```graphql
query cycles($filter: CycleFilter, $first: Int, $after: String) {
  cycles {
    nodes { id number name startsAt endsAt completedAt progress team { id } }
    pageInfo { hasNextPage endCursor }
  }
}

mutation createCycle($input: CycleCreateInput!) {
  cycleCreate(input: $input) { success cycle { id } }
}
# CycleCreateInput required: teamId, startsAt, endsAt; optional: name
```

### Webhooks

```graphql
query webhooks($first: Int) {
  webhooks { nodes { id url enabled resourceTypes secret team { id } } }
}
# resourceTypes: Issue | IssueLabel | Comment | Project | ProjectUpdate | Cycle
#                | Team | User | WorkflowState | Reaction | Attachment
```

## Pagination

Linear uses **cursor-based connection pagination** (Relay spec).

```graphql
# Forward:
query($first: Int = 50, $after: String) {
  issues(first: $first, after: $after) {
    nodes { ... }
    pageInfo {
      hasNextPage    # true = more pages exist
      endCursor      # pass as $after in next call
      hasPreviousPage
      startCursor
    }
  }
}
# Backward: use last + before
```

- Max `first`/`last`: **250** per request, default 50
- `orderBy`: `createdAt` (default) or `updatedAt`  
- Archived excluded by default; add `includeArchived: true`

## Error Codes

| HTTP | GraphQL Extension Code | Meaning |
|------|------------------------|----------|
| 200 | — | Success (check `errors[]` in body) |
| 400 | `GRAPHQL_PARSE_FAILED` | Invalid query syntax |
| 400 | `GRAPHQL_VALIDATION_FAILED` | Schema validation error |
| 401 | `AUTHENTICATION_ERROR` | Missing/invalid API key |
| 403 | `AUTHORIZATION_ERROR` | Insufficient scope |
| 404 | `ENTITY_NOT_FOUND` | Resource does not exist |
| 422 | `UNPROCESSABLE_ENTITY` | Business logic validation failed |
| 429 | `RATE_LIMIT_EXCEEDED` | Rate limit hit |
| 500 | `INTERNAL_SERVER_ERROR` | Linear server error |

Errors in response body (even on HTTP 200):
```json
{
  "data": null,
  "errors": [{
    "message": "Entity not found",
    "locations": [{"line": 2, "column": 3}],
    "extensions": { "code": "ENTITY_NOT_FOUND", "type": "entityNotFound", "userPresentableMessage": "Issue not found" }
  }]
}
```

## Gotchas

1. **GraphQL not REST** — single POST endpoint; no REST URLs per resource.
2. **Complexity compounds** — deeply nested queries + large `first` values exhaust complexity budget fast; paginate and select only needed fields.
3. **IDs are UUID strings** — never integers; always pass as `String!` in variables.
4. **Mutations return `success` bool** — check `success` before trusting returned entity; failure returns `success: false` with no entity.
5. **Soft-delete only** — `archiveIssue` / `archiveProject` soft-deletes; permanently deleted items only via UI.
6. **Team scope required on create** — Issues, Labels, WorkflowStates need `teamId`.
7. **Webhook payload HMAC** — validate incoming webhooks: `linear-signature` header = HMAC-SHA256 of raw body with your webhook secret.
8. **OAuth token refresh** — personal API keys never expire; OAuth tokens may expire; implement refresh flow.
9. **`viewer` vs `user($id)`** — `viewer` resolves to authenticated caller; `user($id)` fetches any org member.
10. **Partial updates** — `IssueUpdateInput` fields omitted are left unchanged; no need to re-send all fields.
11. **`description` is Markdown** — `descriptionData` is ProseMirror JSON (internal); prefer `description` for input.
12. **Linear MCP worker** — 21 tools in the mcp-hub cover the most common operations; use SDK for advanced queries.


## playwright

# Playwright v1.60 — Compressed Reference

Generated by github-docs skill from microsoft/playwright (main). Source: https://github.com/microsoft/playwright

## Install

```bash
npm init playwright@latest          # full scaffold
npm i -D @playwright/test           # add to existing project
npx playwright install              # download browsers
npx playwright install chromium --with-deps  # CI: only needed browser
```

## Test Structure

```ts
import { test, expect } from '@playwright/test';

test('title', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example/);
});

test.describe('group', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });
  test.afterEach(async ({ page }) => { /* teardown */ });
  test('case', async ({ page }) => { /* ... */ });
});

// Parallel within a file
test.describe.configure({ mode: 'parallel' });

// Skip / only
test.skip('reason');
test.only('focused test', async ({ page }) => {});
```

## Locators (preferred order)

```ts
page.getByRole('button', { name: 'Submit' })    // ARIA role + accessible name
page.getByLabel('Email')                         // form label
page.getByPlaceholder('Search...')              // input placeholder
page.getByText('Welcome')                        // visible text
page.getByAltText('Logo')                        // img alt
page.getByTitle('Tooltip')                       // title attr
page.getByTestId('login-form')                   // data-testid

// Chaining / filtering
page.getByRole('listitem').filter({ hasText: 'Product 2' })
page.getByRole('listitem').filter({ has: page.getByRole('button') })
page.frameLocator('#iframe').getByRole('button', { name: 'OK' })

// Nth / first / last
page.getByRole('listitem').first()
page.getByRole('listitem').last()
page.getByRole('listitem').nth(2)

// CSS / XPath (avoid — fragile)
page.locator('css=button.submit')
page.locator('xpath=//button')
```

## Actions

```ts
await locator.click()                          // click
await locator.dblclick()                       // double-click
await locator.hover()                          // hover
await locator.fill('value')                    // clear + type
await locator.type('value')                    // type char-by-char
await locator.press('Enter')                   // keyboard key
await locator.check()  / .uncheck()            // checkbox
await locator.selectOption('option')           // <select>
await locator.setInputFiles('file.pdf')        // file upload
await locator.focus()
await locator.blur()
await locator.clear()
await locator.tap()                            // touch
await page.goto('https://example.com')         // navigation
await page.goBack()  / page.goForward()
await page.reload()
await page.waitForURL('**/dashboard')
await page.screenshot({ path: 'shot.png' })
```

## Assertions (web-first — auto-retry)

```ts
await expect(locator).toBeVisible()
await expect(locator).toBeHidden()
await expect(locator).toBeEnabled()
await expect(locator).toBeDisabled()
await expect(locator).toBeChecked()
await expect(locator).toHaveText('exact') / toContainText('sub')
await expect(locator).toHaveValue('input value')
await expect(locator).toHaveAttribute('href', /regex/)
await expect(locator).toHaveCount(3)
await expect(locator).toHaveClass('active')
await expect(page).toHaveTitle(/Playwright/)
await expect(page).toHaveURL('https://example.com/dashboard')
await expect(response).toBeOK()

// Soft assertions (don't stop test)
await expect.soft(locator).toHaveText('ok');

// Negation
await expect(locator).not.toBeVisible()
```

## playwright.config.ts

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 30_000,
  expect: { timeout: 5000 },
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    video: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

## Auth / Storage State

```ts
// Save after login
await page.context().storageState({ path: 'auth.json' });

// Reuse in tests
test.use({ storageState: 'auth.json' });

// Or in playwright.config.ts
use: { storageState: 'auth.json' }
```

## Network Interception

```ts
// Mock a route
await page.route('**/api/data', route => route.fulfill({
  status: 200,
  body: JSON.stringify({ items: [] }),
}));

// Abort a request
await page.route('**/*.png', route => route.abort());

// Modify request
await page.route('**/api/**', async route => {
  const response = await route.fetch();
  const json = await response.json();
  json.extra = 'patched';
  await route.fulfill({ response, json });
});

// Wait for a specific request/response
const [response] = await Promise.all([
  page.waitForResponse('**/api/data'),
  page.getByRole('button').click(),
]);
```

## Fixtures

```ts
import { test as base } from '@playwright/test';

type MyFixtures = { myPage: Page };

export const test = base.extend<MyFixtures>({
  myPage: async ({ page }, use) => {
    await page.goto('/app');
    await use(page);
    // teardown after test
  },
});

export { expect } from '@playwright/test';
```

## CLI Commands

```bash
npx playwright test                        # run all tests
npx playwright test --headed               # show browser
npx playwright test --debug                # Playwright Inspector
npx playwright test --ui                   # UI mode (watch)
npx playwright test --trace on             # capture traces
npx playwright test example.spec.ts        # single file
npx playwright test -g 'test name'         # filter by name
npx playwright test --project=chromium     # single browser
npx playwright test --shard=1/3            # CI sharding
npx playwright show-report                 # open HTML report
npx playwright show-trace trace.zip        # open trace viewer
npx playwright codegen https://example.com # record test
```

## Browser Contexts & Pages

```ts
// Direct browser control (library mode)
import { chromium } from 'playwright';
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  locale: 'en-US',
  geolocation: { latitude: 40.7, longitude: -74 },
  permissions: ['geolocation'],
  recordVideo: { dir: 'videos/' },
});
const page = await context.newPage();
await page.goto('https://example.com');
await context.close();
await browser.close();
```

## Best Practices

- Prefer `getByRole` > `getByLabel` > `getByTestId` > CSS/XPath
- Use `await expect(locator).toBeVisible()` not `expect(await locator.isVisible()).toBe(true)`
- Each test should be isolated — no shared mutable state between tests
- Mock third-party APIs with `page.route()` — never rely on external servers
- Set `trace: 'on-first-retry'` in CI config; view with `show-trace`
- Run `tsc --noEmit` + ESLint `no-floating-promises` on CI
- Use `--shard=N/M` for large suites on CI
- Install only needed browsers on CI (`playwright install chromium --with-deps`)

## MCP / Agent Mode

```bash
# Playwright MCP server for AI agents
npx @playwright/mcp@latest

# Playwright CLI (more token-efficient for coding agents)
npm install -g @playwright/cli@latest
```


## posthog-rest-api

# PostHog REST API — 2026-05

Full reference for the PostHog private REST API used by posthog-mcp worker.
Source: https://posthog.com/docs/api

---

## Auth & Base URLs

Bearer token in Authorization header — personal API key (prefix `phx_`):
```
Authorization: Bearer ${POSTHOG_PERSONAL_API_KEY}
```

| Region | Private base | Public base |
|--------|-------------|-------------|
| US Cloud | `https://us.posthog.com` | `https://us.i.posthog.com` |
| EU Cloud | `https://eu.posthog.com` | `https://eu.i.posthog.com` |
| Self-hosted | `https://<your-domain>` | same |

Path pattern: `/api/projects/:project_id/<resource>/`
Alternative: `/api/environments/:environment_id/<resource>/`

---

## Rate Limits

| Endpoint class | Limit |
|----------------|-------|
| Analytics (events, persons) | 240/min, 1200/hr |
| Query endpoint | 2400/hr |
| CRUD (flags, experiments, cohorts) | 480/min, 4800/hr |
| Public POST (capture, flags/decide) | None |

Limits apply team-wide across all API keys.

---

## Pagination

All list endpoints return:
```json
{ "count": N, "next": "<url or null>", "previous": "<url or null>", "results": [...] }
```
Follow `next` URL directly to get the next page. Encode `next` as opaque cursor; pass back as `next_cursor`.
Ignore `limit`/`offset` when `next_cursor` is set.

---

## Events API

**Scopes:** `query:read`

```
GET /api/projects/:project_id/events/
  ?after=<ISO>  &before=<ISO>  &distinct_id=<str>  &event=<str>
  &limit=<int>  &offset=<int>  &properties=<arr>  &format=json|csv

GET /api/projects/:project_id/events/:id/
GET /api/projects/:project_id/events/values/
```

Response event object:
```json
{
  "id": "<uuid>",
  "distinct_id": "<str>",
  "event": "$pageview",
  "timestamp": "<ISO>",
  "properties": {},
  "person": { "id": N, "uuid": "<uuid>", "distinct_ids": [], "properties": {} },
  "elements": []
}
```

Note: Events API is deprecated — prefer data pipeline batch exports for bulk export.

---

## Persons API

**Scopes:** `person:read`, `person:write`, `activity_log:read`

```
GET  /api/projects/:project_id/persons/
  ?distinct_id=<str>  &email=<str>  &search=<str>
  &limit=<int>  &offset=<int>  &properties=<arr>  &format=json|csv

GET   /api/projects/:project_id/persons/:id/
PATCH /api/projects/:project_id/persons/:id/
DELETE (via environment path only):
  DELETE /api/environments/:env_id/persons/:id/

POST /api/environments/:env_id/persons/:id/delete_property/  { "$unset": ["prop"] }
POST /api/environments/:env_id/persons/:id/update_property/  { key: str, value: any }
POST /api/environments/:env_id/persons/:id/split/
```

Response person object:
```json
{
  "id": N,
  "uuid": "<uuid>",
  "name": "<str>",
  "distinct_ids": ["<str>"],
  "properties": {},
  "created_at": "<ISO>",
  "last_seen_at": "<ISO>"
}
```

GDPR deletion: DELETE on `/api/environments/:env_id/persons/:id/` — requires confirmation param `delete_events=true` for full removal.
Prefer `$unset` via capture API for property deletion over direct PATCH.

---

## Insights API

**Scopes:** `insight:read`, `insight:write`

```
GET    /api/projects/:project_id/insights/
  ?insight=TRENDS|FUNNELS|RETENTION|PATHS|STICKINESS|LIFECYCLE|SQL|JSON
  &search=<str>  &saved=<bool>  &favorited=<bool>  &dashboards=<id>
  &created_by=<id>  &tags=<str>  &short_id=<str>
  &refresh=blocking|async|force_blocking|force_async|lazy_async|force_cache
  &limit=<int>  &offset=<int>

POST   /api/projects/:project_id/insights/      { name, query, dashboards, tags, description }
GET    /api/projects/:project_id/insights/:id/
PATCH  /api/projects/:project_id/insights/:id/
DELETE /api/projects/:project_id/insights/:id/
```

Response insight fields: `id`, `short_id`, `name`, `derived_name`, `query`, `result`, `columns`, `tags`, `favorited`, `is_cached`, `last_refresh`, `timezone`, `created_at`, `updated_at`, `created_by`, `dashboards`.

---

## HogQL / Query API

**Scope:** `query:read`

```
POST /api/projects/:project_id/query/
```

Request:
```json
{
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT event, count() FROM events WHERE timestamp > now() - interval 7 day GROUP BY event ORDER BY count() DESC LIMIT 100"
  },
  "async": false,
  "refresh": "blocking"
}
```

Response:
```json
{
  "results": [["$pageview", 1234], ...],
  "columns": ["event", "count()"],
  "hasMore": false,
  "query_status": { "complete": true, "error": false, "task_id": "<str>" }
}
```

Async helpers:
```
GET    /api/projects/:project_id/query/:id/      # poll results
DELETE /api/projects/:project_id/query/:id/      # cancel
GET    /api/projects/:project_id/query/:id/log/  # logs (24h retention)
POST   /api/projects/:project_id/query/upgrade/  # migrate to latest query format
```

HogQL tables: `events`, `persons`, `person_distinct_ids`, `session_replay_events`, `groups`.
Timestamp filter required for performance — always include `WHERE timestamp > <cutoff>`.

---

## Feature Flags API

**Scopes:** `feature_flag:read`, `feature_flag:write`

```
GET    /api/projects/:project_id/feature_flags/
  ?active=true|false|STALE  &type=boolean|multivariant|experiment|remote_config
  &search=<str>  &tags=<str>  &limit=<int>  &offset=<int>
  &evaluation_runtime=both|client|server

POST   /api/projects/:project_id/feature_flags/
  { key: str (required), name: str, filters: obj, active: bool, tags: [] }

GET    /api/projects/:project_id/feature_flags/:id/
PATCH  /api/projects/:project_id/feature_flags/:id/
DELETE /api/projects/:project_id/feature_flags/:id/

GET    /api/projects/:project_id/feature_flags/:id/dependent_flags/
POST   /api/projects/:project_id/feature_flags/:id/create_static_cohort_for_flag/
```

Filters object for flag creation/update:
```json
{
  "groups": [
    {
      "properties": [{ "key": "email", "value": "@example.com", "operator": "icontains", "type": "person" }],
      "rollout_percentage": 100
    }
  ],
  "multivariate": {
    "variants": [
      { "key": "control", "name": "Control", "rollout_percentage": 50 },
      { "key": "test", "name": "Test", "rollout_percentage": 50 }
    ]
  },
  "payloads": { "test": "{\"color\": \"blue\"}" }
}
```

Local evaluation endpoint (public key — no auth):
```
POST https://us.i.posthog.com/flags
  { api_key: "<phc_PUBLIC_KEY>", distinct_id: "<str>", groups: {}, person_properties: {}, group_properties: {} }
```

---

## Experiments API

**Scopes:** `experiment:read`, `experiment:write`

```
GET    /api/projects/:project_id/experiments/
  ?status=running|draft|complete|paused|stopped|all
  &search=<str>  &archived=<bool>  &created_by_id=<int>  &feature_flag_id=<int>
  &limit=<int>  &offset=<int>

POST   /api/projects/:project_id/experiments/
  { name, feature_flag_key, description, start_date, end_date,
    parameters, metrics, secondary_metrics, filters, type, archived }

GET    /api/projects/:project_id/experiments/:id/
PATCH  /api/projects/:project_id/experiments/:id/
DELETE /api/projects/:project_id/experiments/:id/

POST   /api/projects/:project_id/experiments/:id/archive/
POST   /api/projects/:project_id/experiments/:id/duplicate/
POST   /api/projects/:project_id/experiments/:id/create_exposure_cohort_for_experiment/
```

Response includes: `id`, `name`, `description`, `status`, `start_date`, `end_date`, `feature_flag_key`, `type`, `archived`, `metrics`, `conclusion`, `created_by`, `created_at`.

---

## Cohorts API

**Scopes:** `cohort:read`, `cohort:write`

```
GET    /api/projects/:project_id/cohorts/
  ?search=<str>  &limit=<int>  &offset=<int>

POST   /api/projects/:project_id/cohorts/
  { name: str, description: str, filters: obj, is_static: bool }

GET    /api/projects/:project_id/cohorts/:id/
PATCH  /api/projects/:project_id/cohorts/:id/
DELETE /api/projects/:project_id/cohorts/:id/

GET    /api/projects/:project_id/cohorts/:id/persons/
```

Filters object (dynamic cohort):
```json
{
  "properties": {
    "type": "AND",
    "values": [
      { "type": "person", "key": "email", "value": "@example.com", "operator": "icontains" }
    ]
  }
}
```

---

## Projects API

**Scopes:** `project:read`

```
GET /api/projects/
  ?limit=<int>  &offset=<int>

GET /api/projects/:project_id/
```

Response: `id`, `name`, `uuid`, `organization`, `api_token` (public key), `created_at`, `timezone`, `anonymize_ips`, `person_display_name_properties`.

---

## Annotations API

**Scopes:** `annotation:read`, `annotation:write`

```
GET    /api/projects/:project_id/annotations/
  ?search=<str>  &scope=dashboard|insight|project  &limit=<int>  &offset=<int>

POST   /api/projects/:project_id/annotations/
  { content: str, date_marker: ISO, scope: "project"|"dashboard"|"insight", creation_type: "USR"|"GIT" }

GET    /api/projects/:project_id/annotations/:id/
PATCH  /api/projects/:project_id/annotations/:id/
DELETE /api/projects/:project_id/annotations/:id/
```

---

## Capture API (public — no auth)

```
POST https://us.i.posthog.com/capture/
  Content-Type: application/json
  { api_key: "<phc_PUBLIC_KEY>", event: str, distinct_id: str, properties: {}, timestamp: ISO }
```

Batch:
```json
{ "api_key": "<phc_PUBLIC_KEY>", "batch": [{ "event": "...", "distinct_id": "...", "properties": {} }] }
```

---

## Multi-Client Pattern (agency use)

Different clients have separate `POSTHOG_API_KEY` + `POSTHOG_PROJECT_ID` pairs.
Use a `client` routing param to select config; worker resolves via `resolveClient(env, clientName)`.
Fallback to `POSTHOG_API_KEY` / `POSTHOG_PROJECT_ID` env vars when no client specified.

---

## Error Codes

| Status | Meaning |
|--------|--------|
| 401 | Bad/missing API key |
| 403 | Insufficient scope |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 5xx | PostHog server error (retryable) |

Generated: 2026-05-11 | Source: posthog.com/docs/api (live fetch)


## shadcn-ui

# shadcn/ui

**Not a component library — a code distribution platform.** You own the source. Open Code, composable interface, AI-ready.

Stars: 112k. Docs: https://ui.shadcn.com

---

## Core Principles

- **Open Code** — component source lives in your repo; edit directly
- **Composition** — every component shares a common, predictable API
- **Distribution** — flat-file schema + CLI for cross-project/framework sharing
- **AI-Ready** — open code + consistent API lets LLMs read/generate/improve components
- **Tailwind v4 + React 19** — default for new projects; v3/React 18 still supported

---

## CLI (`shadcn`)

```bash
npx shadcn@latest init          # init new or existing project
npx shadcn@latest add [name]   # add one component
npx shadcn@latest add          # interactive picker
npx shadcn@latest add --all    # add every component
npx shadcn@latest diff         # show upstream changes
npx shadcn@latest build        # build registry
npx shadcn@latest mcp init --client claude  # wire MCP server
```

### `init` Options (key flags)

```
-t, --template <next|vite|start|react-router|laravel|astro>
-b, --base <radix|base>
-p, --preset [name]   # use a saved preset
-n, --name <name>     # create new project with this name
--monorepo            # scaffold Turborepo monorepo
--rtl                 # enable RTL support
--css-variables       # (default true)
--reinstall           # re-install existing UI components
```

### `add` Options

```
-y, --yes       # skip confirm
-o, --overwrite # overwrite existing files
-a, --all       # add all components
-p, --path      # custom install path
--dry-run       # preview without writing
```

### Component sources — `add` accepts name, URL, or local path:
```bash
npx shadcn add button
npx shadcn add https://ui.shadcn.com/r/button.json
npx shadcn add ./my-component.json
```

---

## components.json (project config)

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "registries": {
    "@acme": "https://acme.com/r/{name}.json"
  }
}
```

Key fields:
- `style` — `new-york` (default; `default` deprecated)
- `tsx: false` — opt into JavaScript output
- `tailwind.config` — blank for Tailwind v4
- `tailwind.baseColor` — seeds default theme tokens; immutable after init
- `registries` — custom registries; resolved in `add` by `@acme/button` prefix

---

## Theming — CSS Variables

All tokens live under `:root` and `.dark` in your CSS file.

```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --radius: 0.625rem;
  --chart-1: oklch(0.646 0.222 41.116);
  /* chart-2 .. chart-5 */
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
}
```

Token pairs: surface token + `-foreground` for text on it.
Dark mode: override same tokens inside `.dark { }` selector.

### Tailwind usage

```tsx
<div className="bg-background text-foreground" />
<div className="bg-primary text-primary-foreground" />
<div className="bg-card text-card-foreground border border-border" />
```

---

## Component Catalogue (54 UI components)

```
accordion, alert, alert-dialog, aspect-ratio, avatar, badge,
breadcrumb, button, button-group, calendar, card, carousel,
chart, checkbox, collapsible, command, context-menu, dialog,
drawer, dropdown-menu, empty, field, form, hover-card, input,
input-group, input-otp, item, kbd, label, menubar, native-select,
navigation-menu, pagination, popover, progress, radio-group,
resizable, scroll-area, select, separator, sheet, sidebar,
skeleton, slider, sonner, spinner, switch, table, tabs,
textarea, toggle, toggle-group, tooltip
```

Install any: `npx shadcn@latest add <name>`

---

## Component API Pattern

All components use the same composition pattern — no forwardRef wrappers (React 19):

```tsx
// Button — cva variants + Slot for polymorphism
import { Button } from "@/components/ui/button"
<Button variant="default|destructive|outline|secondary|ghost|link"
        size="default|sm|lg|icon">
  Click me
</Button>
<Button asChild><a href="/">Link</a></Button>  // renders <a>

// Dialog
import { Dialog, DialogTrigger, DialogContent,
         DialogHeader, DialogTitle, DialogDescription,
         DialogFooter, DialogClose } from "@/components/ui/dialog"

// Form (react-hook-form wrapper)
import { Form, FormField, FormItem, FormLabel,
         FormControl, FormDescription, FormMessage } from "@/components/ui/form"
// Wrap with <Form {...form}> then <FormField control={form.control} name="..."> pattern

// data-slot attribute on every primitive — use for CSS targeting:
[data-slot="dialog-content"] { ... }
```

Radix UI is the headless primitive layer (`import { Dialog } from "radix-ui"`).
`cn()` from `@/lib/utils` (clsx + tailwind-merge) is used in every component.

---

## Installation by Framework

| Framework | Command |
|-----------|--------|
| Next.js | `npx shadcn@latest init -t next` |
| Vite + React | `npx shadcn@latest init -t vite` |
| TanStack Start | `npx shadcn@latest init -t start` |
| React Router v7 | `npx shadcn@latest init -t react-router` |
| Laravel (Inertia) | `npx shadcn@latest init -t laravel` |
| Astro | `npx shadcn@latest init -t astro` |
| Remix | manual (see docs/installation/remix) |

---

## Monorepo Support

```bash
npx shadcn@latest init --monorepo  # creates apps/web + packages/ui + Turborepo
cd apps/web && npx shadcn@latest add button  # CLI resolves correct workspace
```

CLI automatically routes component files to `packages/ui`, fixes import paths in `apps/*`.

---

## MCP Server

AI assistants can browse and install components via MCP:

```bash
npx shadcn@latest mcp init --client claude   # Claude Code
npx shadcn@latest mcp init --client cursor
npx shadcn@latest mcp init --client vscode
```

MCP server reads registries from `components.json`. Prompts: "Add the button and dialog components" / "Show me all available components".

---

## Registry System

Components are distributed as JSON files at `https://ui.shadcn.com/r/{name}.json`.
Custom registries: set `registries["@prefix"] = "https://yoursite.com/r/{name}.json"` in `components.json`.
Build your own: `npx shadcn build` generates registry JSON from source.

---

## Dependencies

- `class-variance-authority` — variant authoring
- `clsx` + `tailwind-merge` — conditional class merging via `cn()`
- `lucide-react` — default icon set
- `radix-ui` — headless primitives (dialog, dropdown, etc.)
- `react-hook-form` — form state (used in `form.tsx`)
- `zod` — schema validation (used alongside form)
- `tw-animate-css` (devDep) — animation utilities

---

## Repo Structure

```
apps/v4/
  registry/new-york-v4/ui/   — component source (.tsx)
  registry/new-york-v4/hooks/ — shared hooks
  content/docs/              — MDX documentation
packages/shadcn/src/         — CLI source
  commands/                  — add.ts, init.ts, mcp.ts, diff.ts, build.ts
  schema/                    — components.json schema
  registry/                  — registry fetch/resolve utilities
```

Dev: `pnpm install && pnpm dev` (Turborepo). Changesets for releases.


## vitest

# Vitest v4.1.5

Next-generation testing framework powered by Vite. Jest-compatible API. Requires Vite >=6.0.0, Node >=20.0.0.
Source: https://github.com/vitest-dev/vitest | Docs: https://vitest.dev

## Install

```bash
npm install -D vitest
# or: pnpm add -D vitest | yarn add -D vitest | bun add -D vitest
```

Add to `package.json`:
```json
{ "scripts": { "test": "vitest", "test:run": "vitest run" } }
```

Test files: must contain `.test.` or `.spec.` in filename.

## Basic Test Structure

```ts
import { describe, expect, it, test, beforeEach, afterEach } from 'vitest'

describe('suite name', () => {
  beforeEach(() => { /* setup */ })
  afterEach(() => { /* teardown */ })

  it('foo', () => { expect(1 + 1).toEqual(2) })
  it.concurrent('parallel', async ({ expect }) => {})
  it.todo('planned')
  it.skip('skipped', () => {})
  it.only('only this', () => {})
  it('with options', { timeout: 10_000, retry: 2, tags: ['db'] }, () => {})
})
```

## Test Options (v4.1+)

```ts
test('name', {
  timeout: 10_000,           // ms; default 5000
  retry: 2,                  // retry count on failure
  retry: {                   // v4.1+: fine-grained retry
    count: 3,
    delay: 500,              // ms between retries
    condition: /timeout/,    // only retry on matching error
  },
  repeats: 3,               // run N additional times (flake debug)
  tags: ['db', 'flaky'],    // v4.1+: custom tags (must be in config unless strictTags:false)
  meta: { jiraId: 'PROJ-1' }, // v4.1+: custom metadata for reporters
  skip: true,
  concurrent: true,
}, () => {})
```

## Config (`vitest.config.ts`)

Vitest reads `vite.config.*` automatically. For test-specific overrides use `mergeConfig`:

```ts
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Option A: standalone (does not inherit vite.config.ts)
export default defineConfig({ test: { /* ... */ } })

// Option B: extend from vite.config.ts (recommended)
export default mergeConfig(viteConfig, defineConfig({ test: { /* ... */ } }))
```

Full `test` block options:
```ts
test: {
  // Discovery
  include: ['**/*.{test,spec}.{ts,tsx,js,jsx}'],
  exclude: ['node_modules', 'dist'],
  includeSource: [],         // in-source testing via import.meta.vitest

  // Environment
  globals: true,             // no imports needed for describe/it/expect
  environment: 'node',       // 'jsdom' | 'happy-dom' | 'edge-runtime'
  environmentOptions: {},
  setupFiles: ['./setup.ts'],
  globalSetup: ['./global-setup.ts'], // runs once per process
  root: './',

  // Execution
  pool: 'forks',             // 'threads' | 'vmForks' | 'vmThreads'
  poolOptions: {
    forks: { singleFork: false, isolate: true },
    threads: { singleThread: false, useAtomics: true },
  },
  maxWorkers: undefined,
  minWorkers: undefined,
  fileParallelism: true,     // run test files in parallel (default true)
  isolate: true,
  maxConcurrency: 5,
  testTimeout: 5000,         // per-test timeout (ms)
  hookTimeout: 10000,        // per-hook timeout (ms)

  // Retry / Bail
  retry: 0,
  bail: 0,                   // stop after N failures (0=never)

  // Reporters
  reporters: ['default'],    // 'verbose'|'dot'|'json'|'junit'|'html'|'tap'
  outputFile: './report.json', // or { json: './r.json', junit: './j.xml' }

  // Snapshots
  snapshotOptions: { expand: false, printBasicPrototype: false },
  resolveSnapshotPath: (path, ext) => path.replace('/src', '/snaps') + ext,
  snapshotSerializers: [],

  // Tags (v4.1+)
  tags: ['db', 'unit'],      // allowlist for strictTags
  strictTags: true,

  // Type checking
  typecheck: {
    enabled: false,
    checker: 'tsc',          // or 'vue-tsc'
    include: ['**/*.test-d.ts'],
    tsconfig: './tsconfig.json',
  },

  // Coverage
  coverage: { provider: 'v8' },

  // Browser
  browser: {
    enabled: false,
    name: 'chromium',        // 'firefox' | 'webkit'
    provider: 'playwright',  // or 'webdriverio'
    headless: true,
  },

  // Other
  sequence: { shuffle: false, hooks: 'stack', concurrent: false },
  allowOnly: true,           // allow .only in CI (default: false blocks it)
  passWithNoTests: false,
  watch: false,
  logHeapUsage: false,
}
```

## Globals Mode

With `globals: true`, no imports required in test files:
```ts
// no import needed
describe('suite', () => {
  it('works', () => { expect(1).toBe(1) })
})
```

TypeScript — add to `tsconfig.json`:
```json
{ "compilerOptions": { "types": ["vitest/globals"] } }
```
Or add `/// <reference types="vitest/globals" />` to a `.d.ts` file.

## expect API

```ts
// Equality
expect(val).toBe(2)               // Object.is strict eq
expect(val).toEqual({ a: 1 })     // deep equality
expect(val).toStrictEqual(v)      // strict deep (undefined keys matter)
expect(val).toMatchObject({ a: 1 }) // partial match

// Truthiness
expect(val).toBeTruthy()
expect(val).toBeFalsy()
expect(val).toBeNull()
expect(val).toBeUndefined()
expect(val).toBeDefined()

// Numbers
expect(0.2 + 0.1).toBeCloseTo(0.3, 5)
expect(4).toBeGreaterThan(3)
expect(2).toBeLessThanOrEqual(3)

// Strings / arrays
expect('foobar').toContain('foo')
expect('foobar').toMatch(/foo/)
expect([1, 2, 3]).toHaveLength(3)
expect([1, 2]).toEqual(expect.arrayContaining([1]))

// Errors
expect(() => fn()).toThrow()
expect(() => fn()).toThrow('message')
await expect(async () => fn()).rejects.toThrow()
await expect(promise).resolves.toBe(val)

// Snapshots
expect(val).toMatchSnapshot()
expect(val).toMatchInlineSnapshot(`"FOOBAR"`)
expect(el).toMatchFileSnapshot('./snapshot.txt')

// Negation / soft / poll
expect(val).not.toBe(2)
expect.soft(val).toBe(1)                  // collect all failures
await expect.poll(() => el).toBeTruthy()  // retry until passes

// Assertions count
expect.assertions(2)
expect.hasAssertions()

// Custom message
expect(val, 'failure message').toBe(2)

// Mock assertions
expect(fn).toHaveBeenCalled()
expect(fn).toHaveBeenCalledTimes(2)
expect(fn).toHaveBeenCalledWith('arg1', 'arg2')
expect(fn).toHaveBeenLastCalledWith('arg')
expect(fn).toHaveReturnedWith('val')
// Chai-style (v4.1+)
expect(fn).to.have.been.called()
expect(fn).to.have.been.calledWith('arg')
```

## describe API

```ts
describe('group', () => { ... })
describe.concurrent(...)    // all tests run in parallel
describe.sequential(...)    // force sequential inside concurrent
describe.skip(...)
describe.only(...)
describe.shuffle(...)       // randomize test order
describe.each([[1,1,2],[2,2,4]])('add %i + %i = %i', (a, b, expected) => {
  it('works', () => expect(a + b).toBe(expected))
})
```

## test.each / it.each / test.for

### Array of arrays
```ts
test.each([
  [1, 1, 2],
  [1, 2, 3],
])('add(%i, %i) -> %i', (a, b, expected) => {
  expect(a + b).toBe(expected)
})
```

### Array of objects
```ts
test.each([
  { a: 1, b: 1, expected: 2 },
  { a: 1, b: 2, expected: 3 },
])('add($a, $b) -> $expected', ({ a, b, expected }) => {
  expect(a + b).toBe(expected)
})
```

### Template literal table
```ts
test.each`
  a    | b    | expected
  ${1} | ${1} | ${2}
  ${1} | ${2} | ${3}
`('add($a, $b) -> $expected', ({ a, b, expected }) => {
  expect(a + b).toBe(expected)
})
```

### Printf-style name tokens
- `%s` string, `%d`/`%i` integer, `%f` float, `%j` JSON, `%o` object
- `%#` zero-based index, `%$` one-based index, `%%` literal percent
- `$prop` / `$prop.nested` for object row property access

### Modifiers on each
```ts
test.skip.each([...])('name', fn)       // skip all variants
test.only.each([...])('name', fn)       // only these
test.concurrent.each([...])('name', fn) // parallel
test.todo.each([...])('name', fn)       // stubs
```

### test.for (v3.1+)
Preserves array structure (no spread); passes TestContext as second arg:
```ts
test.concurrent.for([
  [1, 1],
  [1, 2],
])('add(%i, %i)', ([a, b], { expect }) => {
  expect(a + b).toMatchSnapshot()
})
```

## Hooks

```ts
import { beforeAll, afterAll, beforeEach, afterEach, aroundEach, onTestFailed, onTestFinished } from 'vitest'

beforeAll(async () => { /* once before all tests in suite */ })
afterAll(async () => {})
beforeEach(async (ctx) => {
  return async () => { await cleanup() }  // return = afterEach cleanup
})
afterEach(async (ctx) => {})
onTestFailed(async () => { /* only if test failed */ })
onTestFinished(async () => { /* always */ })

// aroundEach — wrap test in a context (e.g. db transaction)
aroundEach(async (runTest) => {
  await db.transaction(runTest)  // must call runTest()
})
```

## vi (mock utilities)

```ts
import { vi } from 'vitest'

// Mock functions
const fn = vi.fn()
const fn2 = vi.fn(() => 'default')        // with default impl
fn.mockReturnValue('val')
fn.mockReturnValueOnce('first')
fn.mockResolvedValue('async val')
fn.mockImplementation((arg) => arg * 2)
fn.mockImplementationOnce((arg) => arg)
fn.mockRestore()                          // restore original impl
fn.mockClear()                            // clear call history
fn.mockReset()                            // clear + remove impl

// Spy on existing method
const spy = vi.spyOn(obj, 'method')
vi.spyOn(obj, 'getter', 'get').mockReturnValue('mocked')  // getter spy
spy.mockReturnValue('mocked')
spy.mockRestore()    // always restore in afterEach

// Auto-mock plain object (v3.2+)
vi.mockObject(obj)

// Globals / env
vi.stubGlobal('fetch', vi.fn())
vi.unstubAllGlobals()
vi.stubEnv('NODE_ENV', 'test')
vi.unstubAllEnvs()

// Timers
vi.useFakeTimers()
vi.setTimerTickMode('manual')  // v4.1+: 'auto' | 'manual'
vi.runAllTimers()
vi.runAllTimersAsync()
vi.advanceTimersByTime(1000)
vi.advanceTimersByTimeAsync(1000)
vi.advanceTimersToNextTimer()
vi.setSystemTime(new Date('2025-01-01'))
vi.useRealTimers()

// Bulk resets
vi.clearAllMocks()    // clears call history
vi.resetAllMocks()    // clears + removes impl
vi.restoreAllMocks()  // restores all spies

// Async utilities
vi.waitFor(fn, { timeout: 1000, interval: 50 })
vi.waitUntil(fn, { timeout: 1000 })
```

## Module Mocking

```ts
// vi.mock is HOISTED to top of file (Babel-like transform)
vi.mock('./module')                                   // auto-mock
vi.mock('./module', () => ({ fn: vi.fn() }))          // factory
vi.mock('./module', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, method: vi.fn() }               // partial mock
})
vi.mock('./module', { spy: true })                    // spy-only: original runs, calls tracked
vi.doMock('./module', factory)                        // non-hoisted (dynamic; for runtime decisions)
vi.unmock('./module')
vi.importActual('./module')   // real impl inside factory
vi.importMock('./module')     // explicitly get mocked version

// Mock class constructor
vi.mock(import('./example.js'), () => ({
  SomeClass: vi.fn(class FakeClass {
    someMethod = vi.fn()
  })
}))

// Manual mocks: place at __mocks__/<module>.ts
// Vitest auto-uses manual mocks when vi.mock() is called (no factory needed)

// Config-level automocking
test: { server: { deps: { interopDefault: true } } }
```

## Test Context & Fixtures

```ts
it('with context', async ({ expect, task, skip, onTestFailed }) => {
  skip()               // skip dynamically
  onTestFailed(() => console.log('failed'))
  expect(task.name).toBe('with context')
})

// Extend with fixtures
import { test as base } from 'vitest'
export const test = base.extend<{ db: Database }>({
  db: async ({}, use) => {
    const db = await setupDb()
    await use(db)       // run test
    await db.close()    // teardown
  },
})
```

## Snapshot Testing

```ts
// Basic
expect(val).toMatchSnapshot()
expect(val).toMatchSnapshot({ name: 'custom' })
expect(val).toMatchInlineSnapshot()           // auto-written into test file
expect(val).toMatchInlineSnapshot(`"value"`)

// External file
expect(el).toMatchFileSnapshot('./snap.txt')

// Browser mode only
expect(element).toMatchScreenshot()           // visual regression
expect(element).toMatchAriaSnapshot()         // accessibility tree (exp. 4.1.4+)
expect(element).toMatchAriaInlineSnapshot()

// Update: vitest -u  |  press 'u' in watch mode
// CI: snapshot writes blocked when process.env.CI is truthy
// Obsolete snapshots fail CI automatically
```

Custom serializer (in setup file):
```ts
expect.addSnapshotSerializer({
  test: (val) => val?.type === 'component',
  print: (val, printer) => `<${val.type} />`,
})
```

Config-level serializers:
```ts
test: {
  snapshotSerializers: ['./serializers/my-serializer.ts'],
  snapshotOptions: {
    printBasicPrototype: false,   // Vitest default (cleaner than Jest)
    expand: false,
  },
}
```

## Coverage

```ts
// Install provider first:
// npm i -D @vitest/coverage-v8       (default — faster, native V8)
// npm i -D @vitest/coverage-istanbul  (battle-tested, any runtime)

test: {
  coverage: {
    provider: 'v8',              // or 'istanbul'
    enabled: false,              // enable without --coverage flag
    reporter: ['text', 'html', 'lcov'],
    // built-in reporters: text | text-summary | html | html-spa |
    //   lcov | json | clover | cobertura | tap
    reportsDirectory: './coverage',
    include: ['src/**'],
    exclude: ['src/**/*.test.ts', 'node_modules'],
    all: true,                   // report files with 0% coverage
    clean: true,                 // clean dir before each run
    skipFull: false,             // omit 100%-covered files from text output
    ignoreEmptyLines: false,
    sourcemap: true,
    thresholds: {
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
      perFile: true,             // enforce thresholds per individual file
    },
    watermarks: {                // low/high color boundaries in text report
      statements: [50, 80],
      functions: [50, 80],
      branches: [50, 80],
      lines: [50, 80],
    },
    customProviderModule: '',    // path to custom provider module
  },
}
// Run: vitest run --coverage
```

## Type Testing

```ts
import { assertType, expectTypeOf } from 'vitest'

expectTypeOf(fn).toBeFunction()
expectTypeOf(fn).parameter(0).toBeString()
expectTypeOf(fn).returns.toMatchTypeOf<Promise<string>>()
assertType<string>('foo')
```

Config:
```ts
test: {
  typecheck: {
    enabled: true,
    checker: 'tsc',              // or 'vue-tsc'
    include: ['**/*.test-d.{ts,tsx}'],
    tsconfig: './tsconfig.json',
    ignoreSourceErrors: false,
    only: false,
  }
}
// Run: vitest typecheck
```

## Extending Matchers

```ts
// In setup file or test
expect.extend({
  toBeFoo(received) {
    const { isNot } = this
    return {
      pass: received === 'foo',
      message: () => `${received} is${isNot ? ' not' : ''} foo`,
    }
  },
})
// this context: isNot, promise, equals(), utils, currentTestName, testPath, environment
```

TypeScript augmentation (`vitest.d.ts`):
```ts
import 'vitest'
declare module 'vitest' {
  interface Matchers<R = void, T = {}> {
    toBeFoo(): R
  }
}
```
Include `vitest.d.ts` in `tsconfig.json` → `include` array.

## Vite Integration

Vitest reuses `vite.config.*` automatically — Vite plugins, aliases, and transforms all work in tests.

```ts
// vitest.config.ts — extend without breaking Vite build config
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
}))
```

Vite plugins work in tests (`@vitejs/plugin-react`, `svelte`, `vue`, etc.).
Add test-only plugins directly in the test config `plugins` array.

File-level environment override (docblock at top of file):
```ts
// @vitest-environment jsdom
```

Per-test environment:
```ts
it('dom test', { environment: 'jsdom' }, () => {})
```

## Projects (multi-project)

`workspace` deprecated since v3.2 — use `test.projects`:

```ts
export default defineConfig({
  test: {
    projects: [
      'packages/*',                                   // glob — discovers vitest.config.* in each
      'packages/*/vitest.config.{e2e,unit}.ts',
      {                                               // inline with root inheritance
        extends: true,
        test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts'] }
      },
      {
        extends: true,
        test: { name: 'dom', environment: 'jsdom', include: ['src/**/*.test.tsx'] }
      },
    ],
  },
})
```

`defineProject` provides type safety for inline configs (prevents root-only options like `coverage`, `reporters`).
Run specific: `vitest --project unit --project dom`

## Benchmarks

```ts
import { bench, describe } from 'vitest'
describe('sorting', () => {
  bench('native sort', () => { [1,3,2].sort() })
})
// Run: vitest bench
```

## CLI Reference

```bash
vitest              # watch mode
vitest run          # run once (CI)
vitest bench        # benchmark mode
vitest --ui         # browser UI
vitest --reporter=verbose
vitest --coverage
vitest -t 'pattern' # filter by test name
vitest src/foo.test.ts
vitest --pool=threads
vitest --no-isolate  # faster, shared env
vitest --update      # update snapshots
vitest typecheck     # type check only
vitest --project=unit  # filter by project name
```

## Package Info
- npm: `vitest`, `@vitest/ui`, `@vitest/coverage-v8`, `@vitest/coverage-istanbul`, `@vitest/browser`
- ESM-first; TypeScript/JSX built-in via Vite
- Generated: 2026-04-24 from vitest.dev (v4.1.5)


## zod

# Zod v4 — TypeScript-first schema validation

Source: https://github.com/colinhacks/zod  |  npm: `zod` / `@zod/zod` (jsr)
Perf vs v3: strings 14.7×, arrays 7.4×, objects 6.5× faster. TS compile 10× faster. Core bundle 5.36kb gzipped (was 12.47kb).

## Install
```sh
npm install zod
```
Requires TypeScript v5.5+ with `"strict": true` in tsconfig.

## Import
```ts
import * as z from "zod";       // full build (5.36kb gzipped)
import * as z from "zod/mini";  // tree-shakeable subset (1.88kb)
```

---

## Core workflow: parse vs safeParse
```ts
const User = z.object({ name: z.string(), age: z.number() });

// parse — throws ZodError on failure
const data = User.parse(input);

// safeParse — returns discriminated union, never throws
const result = User.safeParse(input);
if (result.success) {
  result.data;   // { name: string; age: number }
} else {
  result.error;  // ZodError — always present on failure
}

// Async variants (required when schema has async refinements/transforms)
const data = await User.parseAsync(input);
const result = await User.safeParseAsync(input);

// Infer static types
type UserIn  = z.input<typeof User>;   // input type (before transforms)
type UserOut = z.infer<typeof User>;   // output type (after transforms)
// z.output<T> is an alias for z.infer<T>
```

---

## Primitives
```ts
z.string(); z.number(); z.bigint(); z.boolean();
z.symbol(); z.undefined(); z.null(); z.void();
z.any(); z.unknown(); z.never();
```

### Coercion
```ts
z.coerce.string();   // String(input)
z.coerce.number();   // Number(input)
z.coerce.boolean();  // Boolean(input)
z.coerce.bigint();   // BigInt(input)
z.coerce.date();     // new Date(input)
```

---

## String validations
```ts
z.string().min(5).max(10).length(8);
z.string().regex(/pattern/);
z.string().startsWith("a").endsWith("z").includes("b");
z.string().uppercase().lowercase();
z.string().trim().toLowerCase().toUpperCase().normalize();
```

## String formats (top-level in v4)
```ts
z.email();                          // strict email (Gmail-like)
z.email({ pattern: z.regexes.html5Email });   // browser-style
z.email({ pattern: z.regexes.rfc5322Email }); // RFC 5322
z.uuid();  z.uuidv4();  z.uuidv6();  z.uuidv7();
z.guid();  // any UUID-like identifier
z.url();   z.httpUrl();  z.hostname();
z.url({ hostname: /^example\.com$/ });
z.url({ protocol: /^https$/ });
z.emoji();  z.base64();  z.base64url();  z.hex();
z.jwt();    z.jwt({ alg: "HS256" });
z.nanoid(); z.cuid();  z.cuid2();  z.ulid();
z.ipv4();  z.ipv6();
z.mac();  z.mac({ delimiter: "-" });
z.cidrv4();  z.cidrv6();
z.hash("sha256");   // "md5"|"sha1"|"sha384"|"sha512"
z.hash("sha256", { enc: "base64" });  // "hex"|"base64"|"base64url"
z.iso.date();       // YYYY-MM-DD
z.iso.time();       // HH:MM[:SS[.s+]]
z.iso.datetime();   // ISO 8601, no offset by default
z.iso.datetime({ offset: true });   // allow timezone offsets
z.iso.datetime({ local: true });    // allow unqualified
z.iso.datetime({ precision: 3 });   // millisecond precision
z.iso.duration();   // ISO 8601 duration

// Custom format
z.stringFormat("cool-id", /^cool-[a-z0-9]{95}$/);
```

---

## Numbers (v4 formats)
```ts
z.number();           // any finite number (NaN/Infinity rejected)
z.int();              // safe integer
z.int32();            // −2³¹ to 2³¹−1
z.uint32();           // 0 to 2³²−1
z.int64();            // −2⁶³ to 2⁶³−1 (BigInt)
z.uint64();           // 0 to 2⁶⁴−1 (BigInt)
z.float32();          // 32-bit float
z.float64();          // 64-bit float
z.nan();              // NaN only
z.number().gt(5).gte(5).lt(5).lte(5);
z.number().positive().nonnegative().negative().nonpositive();
z.number().multipleOf(5);   // alias .step(5)
```

## BigInt
```ts
z.bigint().gt(5n).gte(5n).lt(5n).lte(5n);
z.bigint().positive().nonnegative().negative().nonpositive();
z.bigint().multipleOf(5n);
```

## Dates
```ts
z.date();  // validates Date instances
z.date().min(new Date("1900-01-01")).max(new Date());
```

## File (new in v4)
```ts
z.file();
z.file().min(10_000).max(1_000_000).mime(["image/png", "image/jpeg"]);
```

---

## Literals
```ts
z.literal("tuna");                           // single string
z.literal(12);                               // number
z.literal(true);                             // boolean
z.literal(["red", "green", "blue"]);         // multiple values (v4)
```

## Enums
```ts
const Fish = z.enum(["Salmon", "Tuna", "Trout"]);
Fish.enum;                    // { Salmon: "Salmon", ... }
Fish.exclude(["Salmon"]);
Fish.extract(["Salmon"]);

// Object literal (replaces v3 z.nativeEnum for plain objects)
const Dir = z.enum({ Up: 0, Down: 1 } as const);

// TypeScript enum
enum Color { Red = "red", Blue = "blue" }
const ColorEnum = z.enum(Color);
```

## Stringbool (new in v4)
```ts
const strbool = z.stringbool();
// truthy: "true"|"1"|"yes"|"on"|"y"|"enabled"
// falsy:  "false"|"0"|"no"|"off"|"n"|"disabled"
z.stringbool({ truthy: ["yes"], falsy: ["no"], case: "sensitive" });
```

---

## Optional / Nullable / Nullish
```ts
z.optional(schema);    // same as schema.optional() — allows undefined
z.nullable(schema);    // same as schema.nullable() — allows null
z.nullish(schema);     // allows null | undefined
```

---

## Objects
```ts
// Strip unknown keys (default)
const Dog = z.object({ name: z.string(), age: z.number().optional() });
// Reject unknown keys
const StrictDog = z.strictObject({ name: z.string() });
// Pass through unknown keys
const LooseDog = z.looseObject({ name: z.string() });
// Validate unknown keys with a schema
Dog.catchall(z.string());

// Shape access
Dog.shape.name;
Dog.keyof();   // ZodEnum<["name","age"]>

// Structural operations
Dog.extend({ breed: z.string() });
Dog.safeExtend({ breed: z.string() });  // preserves refinements, type-safe
Dog.pick({ name: true });
Dog.omit({ age: true });
Dog.partial();             // all optional
Dog.partial({ age: true }); // selective
Dog.required();            // all required
Dog.required({ age: true }); // selective

// Prefer spread for merging (avoids quadratic tsc cost)
z.object({ ...A.shape, ...B.shape, extra: z.string() });
```

---

## Arrays / Tuples / Records / Sets / Maps
```ts
z.array(z.string()).min(1).max(10).length(5).nonempty();
arr.element;   // inner schema
arr.unwrap();  // same

z.tuple([z.string(), z.number()]);
z.tuple([z.string(), z.number()]).rest(z.boolean()); // variadic tail

z.record(z.string(), z.number());  // Record<string, number>
z.record(z.enum(["a","b"]), z.string());

z.set(z.string()).min(1).max(5).size(3);
z.map(z.string(), z.number());
```

---

## Unions & Intersections
```ts
z.union([z.string(), z.number()]);
z.string().or(z.number());   // shorthand

z.intersection(A, B);   // or A.and(B)
```

---

## Discriminated Unions (v4 enhanced)

v4 now supports transforms, pipes, and nested unions on the discriminator value:

```ts
// Basic discriminated union (picks variant by discriminator key — faster than z.union)
const Shape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("circle"),  radius: z.number() }),
  z.object({ kind: z.literal("square"),  side: z.number() }),
]);

// v4: discriminator can be a union, pipe, or transform
const MyResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("aaa"), data: z.string() }),
  z.object({ status: z.union([z.literal("bbb"), z.literal("ccc")]) }),
  z.object({ status: z.literal("fail").transform(v => v.toUpperCase()) }),
]);

// Nested discriminated unions compose correctly in v4
const Result = z.discriminatedUnion("type", [
  z.object({ type: z.literal("a"), value: z.string() }),
  innerDU,   // another discriminatedUnion
]);
```

---

## Template Literals (new in v4)
```ts
z.templateLiteral(["hello, ", z.string(), "!"]);
// `hello, ${string}!`

z.templateLiteral([z.number(), z.enum(["px", "em", "rem", "%"])]);
// `${number}px` | `${number}em` | ...
```

---

## Refinements

Refinements run AFTER the base schema passes. Multiple refinements on one schema all execute unless `abort: true` is set.

```ts
// Basic — return falsy to fail (never throw)
z.string().refine(val => val.length > 3, "Too short");

// Error object form
z.string().refine(val => val.startsWith("z"), {
  error: "Must start with z",
  path: ["field"]
});

// abort: true — halt remaining refinements on this failure
const myString = z.string()
  .refine(val => val.length > 8, { error: "Too short!", abort: true })
  .refine(val => val === val.toLowerCase(), { error: "Must be lowercase" });

// when — conditional execution (v4)
const schema = z
  .object({ password: z.string().min(8), confirmPassword: z.string() })
  .refine(data => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
    when(payload) {
      return schema
        .pick({ password: true, confirmPassword: true })
        .safeParse(payload.value).success;
    },
  });

// Cross-field refinement
const PasswordForm = z
  .object({ password: z.string(), confirm: z.string() })
  .refine(d => d.password === d.confirm, {
    message: "Passwords don't match",
    path: ["confirm"],
  });

// IMPORTANT: chaining after .refine() now works in v4
z.string().refine(val => val.includes("@")).min(5); // ✅ v4 only
```

### `.superRefine()` — multiple issues, specific codes
```ts
const UniqueArray = z.array(z.string()).superRefine((val, ctx) => {
  if (val.length > 3) {
    ctx.addIssue({
      code: "too_big",
      maximum: 3,
      origin: "array",
      inclusive: true,
      message: "Too many items",
      input: val,
    });
  }
  if (val.length !== new Set(val).size) {
    ctx.addIssue({ code: "custom", message: "No duplicates", input: val });
  }
});
```

### `.overwrite()` — type-safe in-place transform (v4)

Unlike `.transform()`, `.overwrite()` returns the same schema type (not a ZodPipe), so further chaining of validators works:

```ts
// Returns ZodNumber, not ZodPipe — validators still apply
z.number().overwrite(val => val ** 2).max(100);
z.string().overwrite(val => val.trim()).min(1);
```

---

## Transforms

```ts
// .transform() — changes output type; produces ZodPipe
const stringToLength = z.string().transform(val => val.length);
// z.input<typeof stringToLength>  = string
// z.output<typeof stringToLength> = number
stringToLength.parse("hello"); // => 5

// Standalone z.transform() — accepts any input
const castToString = z.transform((val) => String(val));
castToString.parse(123); // => "123"

// Transform with ctx — push issues and return z.NEVER to abort
const coercedInt = z.transform((val, ctx) => {
  const n = Number.parseInt(String(val));
  if (isNaN(n)) {
    ctx.issues.push({ code: "custom", message: "Not a number", input: val });
    return z.NEVER;  // signals failure without affecting type inference
  }
  return n;
});

// Async transform — requires parseAsync / safeParseAsync
const idToUser = z.string().transform(async (id) => db.getUserById(id));
await idToUser.parseAsync("abc123");
```

### Preprocess
```ts
z.preprocess(val => {
  if (typeof val === "string") return Number.parseInt(val);
  return val;
}, z.int());
```

---

## Async Validation

Any schema with async refinements or async transforms must be parsed with the async variants:

```ts
// Async refinement — requires parseAsync
const userId = z.string().refine(async (id) => {
  return await userExistsInDb(id);
}, "User not found");

await userId.parseAsync("user-123");

// safeParseAsync — never throws
const result = await schema.safeParseAsync(data);
if (result.success) console.log(result.data);
else console.log(result.error.issues);

// Async transform
const enriched = z.string().transform(async (id) => {
  const user = await db.getUser(id);
  return user;
});

// Rule: if unsure, prefer safeParseAsync; sync parse will throw on async schemas
```

---

## Pipes
```ts
// Chain schemas — useful when one schema produces input for the next
const stringToLength = z.string().pipe(z.transform(v => v.length));
stringToLength.parse("hello"); // => 5

// Standalone z.pipe()
z.pipe(z.string(), z.transform(v => Number(v)), z.number().min(0));

// Useful for safe coercions without z.coerce (more controlled)
const safeInt = z.union([
  z.number(),
  z.string().pipe(z.transform(Number)),
]).pipe(z.int());
```

---

## Default & Catch & Prefault
```ts
// .default() — value returned when input is undefined (post-parse)
z.string().default("hello");
z.number().default(Math.random);  // function re-evaluated each parse

// .prefault() — default applied before parsing (v4)
// Useful when the default must flow through transforms/refinements
z.string().transform(val => val.length).prefault("tuna");
// schema.parse(undefined) => 4

// .catch() — fallback on any validation failure
z.number().catch(42);
z.number().catch((ctx) => {
  ctx.error; // the ZodError
  return Math.random();
});
```

---

## JSON Schema conversion (v4)
```ts
// Built-in — no separate import needed in v4
const jsonSchema = z.toJSONSchema(MySchema);

// With metadata
z.toJSONSchema(z.object({
  firstName: z.string().describe("Your first name"),
  age: z.number().meta({ examples: [12, 99] }),
}));

// Legacy import (still works)
import { toJsonSchema } from "zod/v4/json-schema";
```

---

## Metadata & Registry (new in v4)
```ts
// .describe() — shorthand for meta({ description })
z.string().describe("User's email address");

// .meta() — attach arbitrary metadata
z.number().meta({ title: "Age", examples: [25, 30] });

// Registry — typed metadata store, enables JSON Schema generation
const myRegistry = z.registry<{ title: string; description: string }>();
const emailSchema = z.string().email();
myRegistry.add(emailSchema, { title: "Email", description: "User email" });

// Global registry
z.globalRegistry.add(mySchema, { title: "User" });
```

---

## Recursive Types (new in v4)

No type casting required:
```ts
const Category = z.object({
  name: z.string(),
  get subcategories() {
    return z.array(Category);
  },
});
type Category = z.infer<typeof Category>;
// { name: string; subcategories: Category[] }
```

---

## Error handling
```ts
// ZodError has .issues array
error.issues;
// [{ code, path, message, input, ... }]

// Error codes: "invalid_type" | "too_big" | "too_small" | "custom" |
//              "invalid_format" | "invalid_union" | ...

// Format errors
error.format();   // nested { _errors: string[] } tree
error.flatten();  // { formErrors: string[], fieldErrors: Record<string,string[]> }

// Pretty-print (v4)
z.prettifyError(myError);
// Returns multi-line string with ✖ indicators and paths

// Custom message — shorthand
z.string("Not a string!");
z.string().min(5, "Too short!");

// Custom message — object form
z.string({ error: "Bad!" });

// Custom message — function (error map, runs per issue)
z.string({ error: (issue) =>
  issue.input === undefined ? "Required" : "Not a string"
});

// Global locale / error messages (v4)
import { setConfig } from "zod";
z.config(z.locales.en());  // set built-in English locale
// Without this, Zod Mini defaults to "Invalid input" for all errors
```

---

## Branded Types
```ts
const Cat = z.object({ name: z.string() }).brand<"Cat">();
const Dog = z.object({ name: z.string() }).brand<"Dog">();
type Cat = z.infer<typeof Cat>; // { name: string } & z.$brand<"Cat">
type Dog = z.infer<typeof Dog>;

const pluto = Dog.parse({ name: "pluto" });
const simba: Cat = pluto; // ❌ type error — nominal typing enforced

// Brand direction (v4.2+)
z.string().brand<"Cat", "out">();   // output branded (default)
z.string().brand<"Cat", "in">();    // input branded
z.string().brand<"Cat", "inout">(); // both branded
```

---

## Readonly
```ts
const ReadonlyUser = z.object({ name: z.string() }).readonly();
type ReadonlyUser = z.infer<typeof ReadonlyUser>; // Readonly<{ name: string }>
const u = ReadonlyUser.parse({ name: "fido" });
u.name = "simba"; // throws TypeError — Object.freeze() applied at runtime
// Also works on: arrays, tuples, Set, Map
```

---

## Schema introspection & utilities
```ts
schema.parse(data);
schema.safeParse(data);
schema.parseAsync(data);
schema.safeParseAsync(data);
schema.optional();           // wraps in ZodOptional
schema.nullable();           // wraps in ZodNullable
schema.nullish();            // optional + nullable
schema.array();              // wraps in ZodArray
schema.or(other);            // creates ZodUnion
schema.and(other);           // creates ZodIntersection
schema.brand<"B">();         // creates branded type
schema.readonly();           // freezes output
schema.describe("...");      // attaches description metadata
schema.meta({ ... });        // attaches arbitrary metadata
schema.pipe(other);          // chains schemas
schema.unwrap();             // extracts inner schema (optional/nullable/etc)
z.infer<typeof schema>;      // TypeScript output type
z.input<typeof schema>;      // TypeScript input type
z.output<typeof schema>;     // alias for z.infer
```

---

## Zod Mini (`zod/mini`)

Identical validation semantics, functional tree-shakeable API. 64% smaller bundle (2.12kb vs 5.91kb for simple schemas).

```ts
import * as z from "zod/mini";

// Method chaining → wrap functions
const schema = z.nullable(z.optional(z.string()));

// Validators via .check() instead of chaining methods
z.string().check(z.minLength(5), z.maxLength(10), z.trim());
z.number().check(z.gt(0), z.lte(100));

// Available checks
// Numeric: z.lt, z.lte, z.gt, z.gte, z.positive, z.negative, z.multipleOf
// Size:    z.minSize, z.maxSize, z.size, z.minLength, z.maxLength, z.length
// String:  z.regex, z.lowercase, z.uppercase, z.includes, z.startsWith, z.endsWith, z.mime
// Custom:  z.refine, z.check, z.meta, z.describe, z.property
// Mutate:  z.overwrite, z.normalize, z.trim, z.toLowerCase, z.toUpperCase

// Structural helpers (functions, not methods)
z.extend(schema, { extra: z.string() });
z.pick(schema, { field: true });
z.omit(schema, { field: true });
z.partial(schema);
z.required(schema);
z.keyof(schema);

// Shape access via .def
obj.def.shape.field;
nullable.def.innerType;

// Core parse methods retained on all Mini schemas
// .parse, .safeParse, .parseAsync, .safeParseAsync, .brand, .register, .clone

// IMPORTANT: no default locale — add explicitly
z.config(z.locales.en());
```

---

## Type utilities reference
```ts
z.infer<typeof Schema>   // output type (most common)
z.input<typeof Schema>   // input type (differs when transforms present)
z.output<typeof Schema>  // alias for z.infer

// ZodType for generic function params
function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}
```

---

## Dev commands (monorepo)
```sh
pnpm build          # build all packages
pnpm vitest run     # run all tests
pnpm lint           # biome linter + fix
pnpm dev:play       # run play.ts
```
Node.js v24+, pnpm v10.12.1, ES modules throughout.


## zustand

# Zustand v5.0.12

Small, fast, scalable React state management using simplified flux. Store = hook. No providers needed.

```bash
npm install zustand
```

## Core APIs

### create (React)
```ts
create<T>()(stateCreatorFn: StateCreator<T, [], []>): UseBoundStore<StoreApi<T>>
```
Creates a React hook with `setState`, `getState`, `getInitialState`, `subscribe` attached.

```ts
import { create } from 'zustand'
const useBearStore = create<{ bears: number; inc: () => void }>()((set) => ({
  bears: 0,
  inc: () => set((s) => ({ bears: s.bears + 1 })),
}))
// Usage (no provider needed):
const bears = useBearStore((state) => state.bears)
```

### createStore (vanilla)
```ts
createStore<T>()(stateCreatorFn: StateCreator<T, [], []>): StoreApi<T>
```
Vanilla store — no React dependency. Returns `{ setState, getState, getInitialState, subscribe }`.

```ts
import { createStore } from 'zustand/vanilla'
const store = createStore<{ count: number }>()((set) => ({ count: 0 }))
store.setState({ count: 1 })
store.getState().count // 1
const unsub = store.subscribe(console.log)
unsub()
```

### useStore (vanilla → React)
```ts
useStore<S, U>(store: StoreApi<S>, selector: (state: S) => U): U
```
Binds a vanilla store to a React component.

```ts
import { useStore } from 'zustand'
const useBoundStore = (selector) => useStore(vanillaStore, selector)
```

## State Updates

**Flat update** — `set` shallowly merges:
```ts
set({ count: 5 })
set((state) => ({ count: state.count + 1 }))  // updater fn
```

**Replace (no merge)** — second arg `true`:
```ts
set({}, true)  // clears entire store
```

**Read state in action** via `get`:
```ts
const useStore = create((set, get) => ({
  action: () => { const val = get().field; set({ ... }) }
}))
```

**Async actions** — call `set` when ready:
```ts
fetch: async (url) => { const data = await fetchData(url); set({ data }) }
```

**Nested state (manual spread)**:
```ts
set((s) => ({ deep: { ...s.deep, nested: { ...s.deep.nested, count: s.deep.nested.count + 1 } } }))
```

**Nested state with Immer**:
```ts
import { produce } from 'immer'
set(produce((s) => { s.deep.nested.count++ }))
```

## Selectors & Re-renders

Select primitives → strict-equality comparison:
```ts
const count = useStore((s) => s.count)
```

Multiple values → `useShallow` to avoid re-renders when output shallow-equal:
```ts
import { useShallow } from 'zustand/react/shallow'
const { a, b } = useStore(useShallow((s) => ({ a: s.a, b: s.b })))
const [x, y] = useStore(useShallow((s) => [s.x, s.y]))
```

Custom equality fn (requires `createWithEqualityFn`):
```ts
const val = useStore((s) => s.obj, (a, b) => shallowEqual(a, b))
```

## Out-of-Component Usage

```ts
useBearStore.getState().bears       // read
useBearStore.setState({ bears: 0 }) // write
const unsub = useBearStore.subscribe(console.log) // subscribe all
unsub()                             // unsubscribe
```

## Slices Pattern (large stores)

```ts
// fishSlice.ts
export const createFishSlice = (set) => ({
  fishes: 0,
  addFish: () => set((s) => ({ fishes: s.fishes + 1 })),
})
// bearSlice.ts
export const createBearSlice = (set) => ({
  bears: 0,
  addBear: () => set((s) => ({ bears: s.bears + 1 })),
})
// useBoundStore.ts
import { create } from 'zustand'
export const useBoundStore = create((...a) => ({
  ...createBearSlice(...a),
  ...createFishSlice(...a),
}))
```
Apply middlewares only in the combined store, not in individual slices.

Cross-slice actions via `get`:
```ts
export const createBearFishSlice = (set, get) => ({
  addBoth: () => { get().addBear(); get().addFish() }
})
```

## Middlewares

### persist
```ts
persist<T, U>(stateCreatorFn, persistOptions): StateCreator<T, [['zustand/persist', U]], []>
```
Persist store across reloads.

```ts
import { persist, createJSONStorage } from 'zustand/middleware'
const useStore = create(
  persist(
    (set) => ({ count: 0, inc: () => set((s) => ({ count: s.count + 1 })) }),
    {
      name: 'my-storage',                            // localStorage key (required)
      storage: createJSONStorage(() => sessionStorage), // default: localStorage
      partialize: (s) => ({ count: s.count }),       // optional: persist subset
      version: 1,                                    // optional: versioning
      migrate: (persisted, version) => persisted,    // optional: migration fn
      onRehydrateStorage: () => (state, err) => {},  // optional: hydration callback
    }
  )
)
// Access hydration state:
const isHydrated = useStore.persist.hasHydrated()
await useStore.persist.rehydrate()  // manual rehydrate
useStore.persist.clearStorage()     // clear persisted data
```

### devtools
```ts
devtools<T>(stateCreatorFn, devtoolsOptions?): StateCreator<T, [['zustand/devtools', never]], []>
```
Redux DevTools Extension integration. Install `@redux-devtools/extension`.

```ts
import { devtools } from 'zustand/middleware'
const useStore = create(devtools((set) => ({ ... }), {
  name: 'MyStore',       // DevTools connection name
  enabled: true,         // default: true in dev, false in prod
  store: 'storeName',    // separate DevTools connection
  anonymousActionType: 'unknown',  // label for unnamed mutations
  actionsDenylist: ['secret.*'],   // filter actions from DevTools
}))
// Named actions:
set(updater, undefined, 'actionName')
set(updater, undefined, { type: 'actionName', payload })
```

### immer
```ts
immer<T>(stateCreatorFn): StateCreator<T, [['zustand/immer', never]], []>
```
Mutative updates without manual spreading.

```ts
import { immer } from 'zustand/middleware/immer'
const useStore = create(
  immer<State>((set) => ({
    count: 0,
    inc: () => set((s) => { s.count++ }),
    addItem: (item) => set((s) => { s.items.push(item) }),
  }))
)
```

### subscribeWithSelector
Extended subscribe with selector + options:
```ts
import { subscribeWithSelector } from 'zustand/middleware'
const useStore = create(subscribeWithSelector((set) => ({ paw: true })))
const unsub = useStore.subscribe(
  (s) => s.paw,
  (paw, prev) => console.log(paw, prev),
  { equalityFn: shallow, fireImmediately: true }
)
```

### redux
Redux-style reducer:
```ts
import { redux } from 'zustand/middleware'
const useStore = create(redux(reducer, initialState))
// dispatch is attached: useStore.getState().dispatch({ type: 'INC' })
```

### combine
Infer state type from initial state:
```ts
import { combine } from 'zustand/middleware'
const useStore = create(
  combine({ count: 0 }, (set) => ({ inc: () => set((s) => ({ count: s.count + 1 })) }))
)
```

## React Context (dependency injection)

```ts
import { createContext, useContext } from 'react'
import { createStore, useStore } from 'zustand'
const StoreContext = createContext<ReturnType<typeof createStore>>(null)
const App = () => <StoreContext.Provider value={createStore(...)}><Children /></StoreContext.Provider>
const useMyStore = (selector) => useStore(useContext(StoreContext), selector)
```

## TypeScript

```ts
import { create, StateCreator } from 'zustand'
interface BearState { bears: number; inc: (by: number) => void }
const useBearStore = create<BearState>()((set) => ({
  bears: 0,
  inc: (by) => set((s) => ({ bears: s.bears + by })),
}))
```

Typed slices:
```ts
type BearSlice = { bears: number; addBear: () => void }
type FishSlice = { fishes: number; addFish: () => void }
type BoundStore = BearSlice & FishSlice
const createBearSlice: StateCreator<BoundStore, [], [], BearSlice> = (set) => ({
  bears: 0,
  addBear: () => set((s) => ({ bears: s.bears + 1 })),
})
```

With multiple middlewares:
```ts
const useStore = create<BearState>()(
  devtools(persist((set) => ({ bears: 0, inc: (by) => set((s) => ({ bears: s.bears + by })) }), { name: 'bear' }))
)
```

## Transient Updates (high-frequency, no re-render)

```ts
const Component = () => {
  const ref = useRef(useStore.getState().val)
  useEffect(() => useStore.subscribe((s) => { ref.current = s.val }), [])
  // use ref.current directly in RAF/animation loop
}
```

## Exports

| Import | Symbol |
|--------|--------|
| `zustand` | `create` |
| `zustand/vanilla` | `createStore` |
| `zustand` (v4+) | `useStore` |
| `zustand/react/shallow` | `useShallow` |
| `zustand/shallow` | `shallow` |
| `zustand/middleware` | `persist`, `devtools`, `redux`, `combine`, `subscribeWithSelector` |
| `zustand/middleware/immer` | `immer` |
| `zustand/traditional` | `createWithEqualityFn` |

## Key Behavioural Notes

- `set` **merges** by default; pass `true` as second arg to **replace**
- Selectors use `Object.is` (strict equality) — use `useShallow` for object/array selectors
- Store hook is safe to call outside components (returns store utilities, not a hook)
- Middlewares that modify `set`/`get` do NOT apply to bare `getState`/`setState`
- Apply middlewares in combined store only, not inside slices
- `persist` adds `.persist` namespace: `hasHydrated()`, `rehydrate()`, `clearStorage()`, `onHydrate()`, `onFinishHydration()`
- `devtools` defaults `enabled: true` in dev, `false` in prod


<!-- DEVOS_AUTO_END -->


<!-- DEVOS_SKILLS_INDEX_START -->
## Skills (266+ available)
Invoke via '/<skill-name>' or run /find-skills to discover. Full index disabled (token budget).
<!-- DEVOS_SKILLS_INDEX_END -->
