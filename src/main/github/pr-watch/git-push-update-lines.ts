import {
  COMMAND_START,
  shellCode,
  shellSegments,
  withoutHeredocBodyLines,
  withoutShellRedirections
} from '../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { posixShellWords } from '../../../shared/native-chat/tools/native-chat-tool-preview-prefix'

/** One ref this push updated, as git reported it. */
export type GitPushUpdate = {
  /** The remote branch, without `refs/heads/`. */
  branch: string
  /** The new commit as git abbreviated it; null for a new branch, whose line names none. */
  newSha: string | null
  /** The forge host and repository of the `To <url>` line above it; null when git named none we
   *  can read. */
  remote: { host: string; owner: string; repo: string } | null
  /** The `To` URL as git printed it, for resolving an SSH host alias against the checkout's config. */
  remoteUrl: string | null
}

const GIT_PUSH_RUN = new RegExp(`${COMMAND_START}git\\s+push(?=$|[\\s;&|)])`, 'u')

// git-push(1) OUTPUT: ` <flag> <summary> <from> -> <to> (<reason>)`, or with --porcelain
// `<flag>\t<from>:<to>\t<summary> (<reason>)`. Flags: ` ` fast-forward, `+` forced, `*` new ref.
// `-` deleted, `!` rejected and `=` up to date updated nothing, so they never match.
const HUMAN_LINE =
  /^ ([ +*]) (\[new [a-z]+\]|[0-9a-f]+\.\.\.?[0-9a-f]+) +(\S+) -> (\S+)(?: \(.*\))?$/u
const PORCELAIN_LINE =
  /^([ +*])\t[^\t:]*:(\S+)\t(\[new [a-z]+\]|[0-9a-f]+\.\.\.?[0-9a-f]+)(?: \(.*\))?$/u
const SUMMARY_NEW_SHA = /^[0-9a-f]+\.\.\.?([0-9a-f]+)$/u
// `To git@github.com:owner/repo.git`, `To https://github.com/owner/repo`,
// `To ssh://git@host:22/owner/repo.git`: scheme, user and port dropped, host kept.
const TO_LINE =
  /^To (?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u
// `--dry-run`, or a short-option bundle with `n` before any value-taking `o` (`-n`, `-nv`, `-fn`).
const DRY_RUN_WORD = /^(?:--dry-run|-[a-mp-zA-Z]*n[a-zA-Z]*)$/u

/** The push's own words, quoted or bundled, say it is a dry run, which prints real-looking updates. */
function isDryRun(words: readonly string[]): boolean {
  const push = words.findIndex(
    (word, index) => word === 'push' && words.slice(0, index).includes('git')
  )
  return words.slice(push + 1).some((word) => word !== '--' && DRY_RUN_WORD.test(word))
}

/** A script that runs `git push` itself, not as text it carries, and not as a dry run. */
export function runsGitPush(script: string): boolean {
  // Heredoc bodies go first, across the whole script: one body line alone can't show it is text.
  const pushes = shellSegments(withoutHeredocBodyLines(script)).filter((segment) =>
    GIT_PUSH_RUN.test(shellCode(segment))
  )
  return (
    pushes.length > 0 &&
    pushes.every((segment) => {
      // `git push 2>&1` is common, as git writes its update lines to stderr.
      const words = posixShellWords(withoutShellRedirections(segment).trim())
      // Words we can't read can't prove a real push.
      return words !== null && !isDryRun(words)
    })
  )
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
  let remote: GitPushUpdate['remote'] = null
  let remoteUrl: string | null = null
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/u, '')
    const to = line.startsWith('To ') ? TO_LINE.exec(line) : undefined
    if (to !== undefined) {
      remote = to ? { host: to[1]!.toLowerCase(), owner: to[2]!, repo: to[3]! } : null
      remoteUrl = line.slice('To '.length).trim()
      continue
    }
    const human = HUMAN_LINE.exec(line)
    const porcelain = human ? null : PORCELAIN_LINE.exec(line)
    const destination = human?.[4] ?? porcelain?.[2]
    const summary = human?.[2] ?? porcelain?.[3]
    const branch = destination ? branchOf(destination) : null
    if (!branch || !summary) {
      continue
    }
    updates.push({ branch, newSha: SUMMARY_NEW_SHA.exec(summary)?.[1] ?? null, remote, remoteUrl })
  }
  return updates
}
