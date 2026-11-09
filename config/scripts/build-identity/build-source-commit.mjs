import { execFileSync } from 'node:child_process'

// Pin official skill installs to the full build commit so installed and bundled skills agree on every channel.
export function resolveBuildSourceCommit() {
  let commit = ''
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    throw new Error(
      `Could not read the source commit with \`git rev-parse HEAD\`: ${
        error instanceof Error ? error.message : String(error)
      }. Orca builds must run from a git checkout so official skills can pin to it.`
    )
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`\`git rev-parse HEAD\` returned "${commit}", not a full commit hash.`)
  }
  return commit
}
