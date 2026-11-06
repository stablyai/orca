import {
  COMMAND_START,
  shellCode
} from '../../../shared/native-chat/tools/native-chat-opened-pull-requests'

/** One ref this push updated, as git reported it. */
export type GitPushUpdate = {
  /** The remote branch, without `refs/heads/`. */
  branch: string
  /** The new commit as git abbreviated it; null for a new branch, whose line names none. */
  newSha: string | null
}

const GIT_PUSH_RUN = new RegExp(`${COMMAND_START}git\\s+push(?=$|[\\s;&|)])`, 'u')
// A dry run prints the same update lines without updating anything.
const DRY_RUN = /\bgit\s+push\b[^;&|\n]*\s(?:--dry-run|-n)(?=$|[\s;&|)])/u

// git-push(1) OUTPUT: ` <flag> <summary> <from> -> <to> (<reason>)`, or with --porcelain
// `<flag>\t<from>:<to>\t<summary> (<reason>)`. Flags: ` ` fast-forward, `+` forced, `*` new ref.
// `-` deleted, `!` rejected and `=` up to date updated nothing, so they never match.
const HUMAN_LINE =
  /^ ([ +*]) (\[new [a-z]+\]|[0-9a-f]+\.\.\.?[0-9a-f]+) +(\S+) -> (\S+)(?: \(.*\))?$/u
const PORCELAIN_LINE =
  /^([ +*])\t[^\t:]*:(\S+)\t(\[new [a-z]+\]|[0-9a-f]+\.\.\.?[0-9a-f]+)(?: \(.*\))?$/u
const SUMMARY_NEW_SHA = /^[0-9a-f]+\.\.\.?([0-9a-f]+)$/u

/** A script that runs `git push` itself, not as text it carries, and not as a dry run. */
export function runsGitPush(script: string): boolean {
  const code = shellCode(script)
  return GIT_PUSH_RUN.test(code) && !DRY_RUN.test(code)
}

function branchOf(ref: string): string | null {
  if (ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length)
  }
  return ref.startsWith('refs/') ? null : ref
}

/** The branches a push's own output says it updated. Quiet pushes print none: an intended miss. */
export function gitPushUpdates(output: string): GitPushUpdate[] {
  const updates: GitPushUpdate[] = []
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/u, '')
    const human = HUMAN_LINE.exec(line)
    const porcelain = human ? null : PORCELAIN_LINE.exec(line)
    const destination = human?.[4] ?? porcelain?.[2]
    const summary = human?.[2] ?? porcelain?.[3]
    const branch = destination ? branchOf(destination) : null
    if (!branch || !summary) {
      continue
    }
    updates.push({ branch, newSha: SUMMARY_NEW_SHA.exec(summary)?.[1] ?? null })
  }
  return updates
}
