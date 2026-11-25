// The owner's own CLIs on the stand-in host: each logs that the bot reached for it; `gh` and
// agent-slack then run their stand-ins, the rest answer that they aren't here.
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The owner's chat, code-host and cloud CLIs; the agent's own skills (which can't be turned off
// for Codex) call them by name.
const OWNER_TOOLS = [
  'agent-slack',
  'agent-discord',
  'gh',
  'glab',
  'linear',
  'slack',
  'gcloud',
  'gsutil',
  'bq',
  'terraform',
  'kubectl',
  'aws',
  'az',
  'asc',
  'op'
]

/** Writes a shim for each of the owner's tools into the stand-in's bin, beside its bundles. */
export async function writeOwnerToolShims(dir: string): Promise<void> {
  // The owner's own tools would read or post for real: their `gh` is a recorded stand-in, their
  // agent-slack reads as them only where a scenario puts it on the host; the rest aren't here.
  const standIns: Record<string, string> = { 'agent-slack': 'owner-slack.cjs', gh: 'gh.cjs' }
  for (const tool of OWNER_TOOLS) {
    const shim = join(dir, 'bin', tool)
    const standIn = standIns[tool]
    const answer = standIn
      ? `exec node "${join(dir, standIn)}" "$@"`
      : `echo "${tool} is not available here." >&2\nexit 127`
    await writeFile(
      shim,
      `#!/bin/sh\necho '{"kind":"owner-tool","tool":"${tool}"}' >> "$ORCA_EVAL_LOG"\n${answer}\n`
    )
    await chmod(shim, 0o755)
  }
}
