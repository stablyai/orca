import { constants } from 'node:fs'
import { access, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { DirectoryLinkError, lstatIfPresent } from '../../../filesystem/merged-directory-link'

export const WRITER_LOCKS = 'thread-writer-locks'
export const COORDINATION_LOCK = '.coordination.lock'
const PROBE_TIMEOUT_MS = 10_000

type ProbeAnswer = 'held' | 'idle' | 'unknown'
type LockHold =
  | { answer: ProbeAnswer }
  | {
      answer: 'ready'
      stillHeld: () => boolean
      releaseFirst: () => Promise<boolean>
      release: () => Promise<void>
    }

const HELPER_ANSWERS = new Set(['held', 'idle', 'unknown', 'ready', 'released'])
const THREAD_LOCK_NAME =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\.lock$/i

// Codex's own stale-lock sweep (writer_lock.rs): with coordination held exclusively, every
// `<thread id>.lock` is opened read-write and tried without waiting; a free one is released and
// deleted. Codex takes coordination before opening a thread lock, so nothing can start between the
// listing and the try, and a Codex that needs coordination meanwhile waits for it instead of failing.
// Every folder's coordination is taken first; only the first folder's held locks count. In `hold`
// mode an idle answer is `ready`, and coordination stays held until stdin closes.
const PERL_PROBE = `
use Fcntl qw(:flock);
my ($mode, @dirs) = @ARGV;
$| = 1;
sub answer { print "$_[0]\\n"; exit 0 }
my @coordination;
for my $dir (@dirs) {
  open(my $c, '+>>', "$dir/${COORDINATION_LOCK}") or answer('unknown');
  flock($c, LOCK_EX | LOCK_NB) or answer('unknown');
  push @coordination, $c;
}
my $held = 0;
for my $i (0 .. $#dirs) {
  my $dir = $dirs[$i];
  opendir(my $d, $dir) or answer('unknown');
  for my $name (readdir $d) {
    next unless $name =~ /${THREAD_LOCK_NAME.source}/i;
    my $path = "$dir/$name";
    my $l;
    unless (open($l, '+<', $path)) { next if $!{ENOENT}; answer('unknown') }
    if (flock($l, LOCK_EX | LOCK_NB)) { flock($l, LOCK_UN); close $l; unlink $path; next }
    $!{EWOULDBLOCK} ? ($held ||= $i == 0) : answer('unknown');
  }
}
answer('held') if $held;
answer('idle') if $mode ne 'hold';
print "ready\\n";
if ((<STDIN> // '') =~ /^first/) { close($coordination[0]); print "released\\n"; <STDIN> }
`

// The same sweep with LockFileEx (FileStream.Lock), sharing everything Codex's own opens share, so
// a Codex opening a lock meanwhile never meets a sharing violation. Lock violation (33) = contended;
// PowerShell wraps .NET errors, so it's read from the base exception.
const POWERSHELL_PROBE = [
  "$ErrorActionPreference = 'Stop'",
  "$dirs = $env:ORCA_CODEX_THREAD_LOCKS -split '\\|'",
  'function Answer($a) { [Console]::Out.WriteLine($a); exit 0 }',
  '$coordination = @()',
  `foreach ($dir in $dirs) { try { $c = [IO.File]::Open((Join-Path $dir '${COORDINATION_LOCK}'), 'OpenOrCreate', 'ReadWrite', 'ReadWrite, Delete'); $c.Lock(0, 1); $coordination += $c } catch { Answer 'unknown' } }`,
  `$pattern = '${THREAD_LOCK_NAME.source}'`,
  '$held = $false',
  'for ($i = 0; $i -lt $dirs.Count; $i++) {',
  "  try { $paths = [IO.Directory]::GetFiles($dirs[$i]) } catch { Answer 'unknown' }",
  '  foreach ($path in $paths) {',
  '    if ([IO.Path]::GetFileName($path) -notmatch $pattern) { continue }',
  "    try { $l = [IO.File]::Open($path, 'Open', 'ReadWrite', 'ReadWrite, Delete') }",
  "    catch [IO.FileNotFoundException] { continue } catch { Answer 'unknown' }",
  '    $free = $false',
  "    try { $l.Lock(0, 1); $l.Unlock(0, 1); $free = $true } catch { if (($_.Exception.GetBaseException().HResult -band 0xFFFF) -eq 33) { if ($i -eq 0) { $held = $true } } else { $l.Dispose(); Answer 'unknown' } } finally { $l.Dispose() }",
  '    if ($free) { try { [IO.File]::Delete($path) } catch {} }',
  '  }',
  '}',
  "if ($held) { Answer 'held' }",
  "if ($env:ORCA_CODEX_HOLD -ne '1') { Answer 'idle' }",
  "[Console]::Out.WriteLine('ready')",
  // `first`: let go of the first folder's coordination only (it's about to be renamed).
  "if ([Console]::In.ReadLine() -eq 'first') { $coordination[0].Dispose(); [Console]::Out.WriteLine('released'); [void][Console]::In.ReadLine() }"
].join('\n')

async function perlProgram(): Promise<string> {
  // Not every distro ships /usr/bin/perl (NixOS keeps it elsewhere); the spawn then searches PATH.
  return (await access('/usr/bin/perl', constants.X_OK).then(
    () => true,
    () => false
  ))
    ? '/usr/bin/perl'
    : 'perl'
}

// null when the helper couldn't run or answer: no perl, no PowerShell, a timeout.
async function startProbe(dirs: string[], hold: boolean): Promise<LockHold | null> {
  const spec =
    process.platform === 'win32'
      ? {
          program: windowsPowerShellPath(),
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROBE],
          env: {
            ...process.env,
            ORCA_CODEX_THREAD_LOCKS: dirs.join('|'),
            ORCA_CODEX_HOLD: hold ? '1' : '0'
          }
        }
      : {
          program: await perlProgram(),
          args: ['-e', PERL_PROBE, '--', hold ? 'hold' : 'sweep', ...dirs]
        }
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnProcess({ ...spec, stdio: 'pipe' })
  } catch {
    return null
  }
  const closed = new Promise<null>((resolve) => {
    child.once('close', () => resolve(null))
    child.once('error', () => resolve(null))
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  // Skips anything a shell profile or warning printed before the helper's own answer.
  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const line = await Promise.race([lines.next(), closed])
      if (!line || line.done) {
        return null
      }
      const text = String(line.value).trim()
      if (HELPER_ANSWERS.has(text)) {
        return text
      }
    }
  }
  const stop = async (): Promise<void> => {
    child.stdin.end()
    // One that won't exit is killed, so a later pass never waits on it.
    const kill = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS)
    kill.unref?.()
    await closed
    clearTimeout(kill)
  }
  // Killing the helper releases all it holds, so one that never answers can't keep Codex waiting.
  // Never once it's ready: a move in progress must not lose its hold.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, PROBE_TIMEOUT_MS)
  timer.unref?.()
  const answer = await nextLine()
  clearTimeout(timer)
  // A `ready` read after the kill (still buffered) holds nothing anymore.
  const stillHeld = (): boolean =>
    !timedOut && !child.killed && child.exitCode === null && child.signalCode === null
  if (answer === 'ready' && hold && stillHeld()) {
    return {
      answer,
      stillHeld,
      releaseFirst: async () => {
        child.stdin.write('first\n')
        // Before any move starts, so killing one that never acknowledges loses nothing.
        const ack = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS)
        ack.unref?.()
        const released = (await nextLine()) === 'released' && stillHeld()
        clearTimeout(ack)
        return released
      },
      release: stop
    }
  }
  await stop()
  if (answer === 'ready' || timedOut) {
    return null
  }
  return answer === 'held' || answer === 'idle' || answer === 'unknown' ? { answer } : null
}

/**
 * Sweeps a thread-writer-locks folder as Codex does and says whether a Codex may be writing there:
 * a lock counts only while some process holds it (any user, PID namespace or Windows session), and
 * coordination already taken (a writer starting, a publication) counts too. Free locks are deleted,
 * so one a Codex takes later has no stale twin elsewhere. Without the helper nothing is deleted
 * and any lock file left in the folder counts, as before.
 */
async function sweepCodexThreadLocks(locksDir: string): Promise<boolean> {
  const probe = await startProbe([locksDir], false)
  return probe ? probe.answer !== 'idle' : keepsThreadLock(locksDir)
}

/**
 * Moves the account's lock folder into the store's (`move`) with both folders' coordination held
 * exclusively, after sweeping both: no Codex can take or release a thread lock in either meanwhile,
 * so no thread ends up guarded by two files (a release deletes its lock by path, which the link
 * would point at the other writer's file). `held`: a Codex holds a thread lock in the account; the
 * store's own held locks don't count. `busy`: coordination was taken, or a thread is locked in both.
 */
export async function moveIdleThreadLockFolder(
  accountHome: string,
  storeHome: string,
  move: () => Promise<unknown>
): Promise<'moved' | 'held' | 'busy'> {
  const accountLocks = join(accountHome, WRITER_LOCKS)
  // A coordination file a Codex created mid-move would go unheld.
  await mkdir(accountLocks, { recursive: true })
  const hold = await startProbe([accountLocks, join(storeHome, WRITER_LOCKS)], true)
  if (hold?.answer === 'held') {
    return 'held'
  }
  // Without both coordination locks the move could link around a lock taken meanwhile.
  if (!hold || !('release' in hold)) {
    return 'busy'
  }
  try {
    if (await hasThreadLockConflict(accountHome, storeHome)) {
      return 'busy'
    }
    // Windows never renames a folder with a file open inside, the held coordination file
    // included. Once it's let go, a Codex opening any file there fails the rename instead.
    if (process.platform === 'win32' ? !(await hold.releaseFirst()) : !hold.stillHeld()) {
      return 'busy'
    }
    try {
      await move()
    } catch (error) {
      if (isStartingCodexError(error)) {
        return 'busy'
      }
      throw error
    }
    return 'moved'
  } finally {
    await hold.release()
  }
}

// A Codex that started meanwhile: a file it opened (Windows) or the folder it recreated mid-swap.
function isStartingCodexError(error: unknown): boolean {
  if (error instanceof DirectoryLinkError) {
    return error.code === 'link-failed'
  }
  const code = (error as NodeJS.ErrnoException | null)?.code
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
}

// A thread lock only guards a writer while some process holds it: Codex leaves the file behind
// after a crash, and whenever releasing it finds coordination contended, so its mere presence
// proves nothing. A folder that's missing, or a link (its target is swept on its own), has none.
export async function holdsThreadLock(locks: string): Promise<boolean> {
  const folder = await lstatIfPresent(locks)
  if (!folder || folder.isSymbolicLink()) {
    return false
  }
  return sweepCodexThreadLocks(locks)
}

/** Any thread lock file at all, held or not (an unreadable folder may hold one). */
export async function keepsThreadLock(locks: string): Promise<boolean> {
  const names = await readdir(locks).catch((error: unknown) =>
    isDefinitiveAbsence(error) ? [] : null
  )
  return names === null || names.some((name) => THREAD_LOCK_NAME.test(name))
}

// A thread lock in both folders as different files can't merge: the account's may have been taken
// since the sweep, and dropping either name would let a second writer lock the other.
async function hasThreadLockConflict(accountHome: string, storeHome: string): Promise<boolean> {
  for (const name of await readdir(join(accountHome, WRITER_LOCKS)).catch(() => [])) {
    if (name === COORDINATION_LOCK) {
      continue
    }
    const [mine, theirs] = await Promise.all([
      lstatIfPresent(join(accountHome, WRITER_LOCKS, name)),
      lstatIfPresent(join(storeHome, WRITER_LOCKS, name))
    ])
    if (mine && theirs && (mine.dev !== theirs.dev || mine.ino !== theirs.ino)) {
      return true
    }
  }
  return false
}
