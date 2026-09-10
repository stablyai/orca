const ORCA_CLI_CONTRACT_GUIDANCE = `
## Public workspace and projection contract

\`worktree current\`, \`worktree show\`, and \`worktree list\` return \`workspaceKey\`. Use that public value for Maestro; do not pass the internal worktree ID or derive an identity from a path.

Long Task specs and Maestro payloads use bounded UTF-8 files or stdin. \`--spec\` and \`--spec-file\` are mutually exclusive, as are \`--payload\` and \`--payload-file\`.

<!-- cli-contract:start -->
\`\`\`text
ORCA orchestration task-create --spec-file <path|-> --json
ORCA maestro open --run <run-id> --json
ORCA maestro projection show --host <execution-host-id> --workspace <workspace-key> --json
ORCA maestro projection apply --payload-file <path|-> --json
ORCA maestro bootstrap --payload-file <path|-> --json
\`\`\`
<!-- cli-contract:end -->

Use \`agent-context --json\` for canonical payload schemas, required capabilities, preconditions, and copy-safe stdin forms. \`maestro show\` reads authorable document state; \`maestro projection show\` reads projected Run state; \`maestro index\` labels both.

For a supervised Run advertising \`maestro.browser-surface.v1\`, use the managed lifecycle and the returned page identity. Do not create a raw tab:

<!-- cli-contract:start -->
\`\`\`text
ORCA maestro browser-surface open --payload-file <path|-> --json
ORCA snapshot --page <browser-page-id> --json
ORCA click --page <browser-page-id> --element <ref> --json
ORCA maestro browser-surface focus --payload-file <path|-> --json
ORCA maestro browser-surface capture --payload-file <path|-> --json
ORCA maestro browser-surface retain --payload-file <path|-> --json
ORCA maestro browser-surface release --payload-file <path|-> --json
\`\`\`
<!-- cli-contract:end -->
`

const ORCHESTRATION_ATTEMPT_GUIDANCE = `
## Worker Attempt identity

Every \`worker-start\` requires \`--attempt-id\`. Create one stable opaque Attempt ID for each technical attempt, reuse it only for an idempotent retry of that same attempt, and create a new value for replacement work.

<!-- cli-contract:start -->
\`\`\`text
orca orchestration worker-start --task <task_id> --attempt-id <attempt_id> --worktree current --agent codex --json
\`\`\`
<!-- cli-contract:end -->
`

function addWorkerAttemptIdentity(markdown: string): string {
  return markdown.replace(
    /(worker-start --task <[^>]+>)(?! --attempt-id)/g,
    '$1 --attempt-id <attempt_id>'
  )
}

export function applyVersionMatchedGuideContract(name: string, markdown: string): string {
  if (name === 'orca-cli') {
    return `${markdown}\n${ORCA_CLI_CONTRACT_GUIDANCE}`
  }
  if (name === 'orchestration') {
    return `${addWorkerAttemptIdentity(markdown)}\n${ORCHESTRATION_ATTEMPT_GUIDANCE}`
  }
  return markdown
}
