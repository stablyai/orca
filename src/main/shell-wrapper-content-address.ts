/**
 * Decides where a generated shell wrapper tree lives, by hashing its contents.
 *
 * Why: every writer that shares a userData dir -- main's local PTY path, the
 * daemon fork, and the daemons of other builds that outlive the app that
 * spawned them -- wrote one fixed `shell-ready/` tree. Last writer won, and the
 * guard only re-checked that the files were present, never that they were this
 * build's. A daemon whose spawn env no longer agreed with the wrapper on disk
 * then kept launching shells it could not read: the ready marker never fired
 * and every startup command waited out the full readiness timeout, silently.
 *
 * Naming the directory after a hash of its own contents makes that impossible:
 * different bytes are a different directory, so "present" means "written by
 * this build" again. Writing stays in shell-wrapper-file-writer.ts.
 *
 * Why nothing here collects old trees: a tree is ~48KB and a new one appears
 * only when the wrapper templates themselves change, so an install accrues a
 * couple of megabytes a year against a userData directory that runs to tens of
 * gigabytes. Reclaiming that is not worth putting an `rm -rf` on the
 * terminal-spawn path.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ShellWrapperFile } from './shell-wrapper-file-writer'

/** Builds the wrapper set for a tree rooted at `root`, as the writer takes it. */
export type ShellWrapperFileBuilder = (root: string) => readonly ShellWrapperFile[]

// Why a placeholder root: .zshenv bakes in the tree path, so hashing against the
// real root would make the digest depend on the very path it is choosing. A
// fixed stand-in keeps it stable across machines and user data dirs while still
// covering every difference that matters.
//
// Note this string is itself part of the digest, because it appears in the baked
// content. Renaming it re-keys every tree -- which costs one extra ~48KB
// directory per install and nothing else, so it is not worth normalizing out.
//
// The digest therefore covers the probe build, not the literal bytes on disk.
// That holds only while the sole path-dependent thing in a wrapper is the root
// itself. A future template that varies on something else about its location
// would need that input folded in here, or two genuinely different trees would
// collide on one directory.
const HASH_PROBE_ROOT = '/__orca_shell_wrapper_root__'
const ROOT_HASH_LENGTH = 16
// Why the hash sits ABOVE this leaf rather than below it: ZDOTDIR
// self-reference guards -- in TS and as `*/shell-ready/zsh` globs baked into
// the wrapper scripts -- match on that exact suffix. Without it a wrapper
// sources itself and zsh dies with "job table full or recursion limit
// exceeded". `<base>/<hash>/shell-ready/zsh` leaves every guard intact and
// keeps older builds able to recognize a newer build's dir.
const WRAPPER_ROOT_LEAF = 'shell-ready'

export function resolveShellWrapperRoot(baseDir: string, build: ShellWrapperFileBuilder): string {
  const digest = createHash('sha256')
  for (const [path, content] of build(HASH_PROBE_ROOT)) {
    // Relative, so the digest does not vary with the base dir it is naming.
    digest.update(path.slice(HASH_PROBE_ROOT.length))
    digest.update('\0')
    digest.update(content)
    digest.update('\0')
  }
  return join(baseDir, digest.digest('hex').slice(0, ROOT_HASH_LENGTH), WRAPPER_ROOT_LEAF)
}
