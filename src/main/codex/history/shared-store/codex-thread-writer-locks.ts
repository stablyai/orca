import { constants } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { lstatIfPresent } from '../../../filesystem/merged-directory-link'

export const WRITER_LOCKS = 'thread-writer-locks'
export const COORDINATION_LOCK = '.coordination.lock'
const PROBE_TIMEOUT_MS = 10_000

type ProbeAnswer = 'held' | 'idle' | 'unknown'

// Codex's own stale-lock sweep (writer_lock.rs): with coordination held exclusively, every
// `<thread id>.lock` is opened read-write and tried without waiting; a free one is released and
// deleted. Codex takes coordination before opening a thread lock, so nothing can start between the
// listing and the try, and a Codex that needs coordination meanwhile waits for it instead of failing.
const PERL_PROBE = `
use Fcntl qw(:flock);
my ($dir) = @ARGV;
$| = 1;
sub answer { print "$_[0]\\n"; exit 0 }
open(my $c, '+>>', "$dir/${COORDINATION_LOCK}") or answer('unknown');
flock($c, LOCK_EX | LOCK_NB) or answer('unknown');
opendir(my $d, $dir) or answer('unknown');
my $held = 0;
for my $name (readdir $d) {
  next unless $name =~ /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\\.lock$/i;
  my $path = "$dir/$name";
  my $l;
  unless (open($l, '+<', $path)) { next if $!{ENOENT}; answer('unknown') }
  if (flock($l, LOCK_EX | LOCK_NB)) { flock($l, LOCK_UN); close $l; unlink $path; next }
  $!{EWOULDBLOCK} ? ($held = 1) : answer('unknown');
}
answer($held ? 'held' : 'idle');
`

// The same sweep with LockFileEx (FileStream.Lock), sharing everything Codex's own opens share, so
// a Codex opening a lock meanwhile never meets a sharing violation. Lock violation (33) = contended;
// PowerShell wraps .NET errors, so it's read from the base exception.
const POWERSHELL_PROBE = [
  "$ErrorActionPreference = 'Stop'",
  '$dir = $env:ORCA_CODEX_THREAD_LOCKS',
  'function Answer($a) { [Console]::Out.WriteLine($a); exit 0 }',
  `try { $c = [IO.File]::Open((Join-Path $dir '${COORDINATION_LOCK}'), 'OpenOrCreate', 'ReadWrite', 'ReadWrite, Delete'); $c.Lock(0, 1) } catch { Answer 'unknown' }`,
  "$pattern = '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\\.lock$'",
  '$held = $false',
  'foreach ($path in [IO.Directory]::GetFiles($dir)) {',
  '  if ([IO.Path]::GetFileName($path) -notmatch $pattern) { continue }',
  "  try { $l = [IO.File]::Open($path, 'Open', 'ReadWrite', 'ReadWrite, Delete') }",
  "  catch [IO.FileNotFoundException] { continue } catch { Answer 'unknown' }",
  '  $free = $false',
  "  try { $l.Lock(0, 1); $l.Unlock(0, 1); $free = $true } catch { if (($_.Exception.GetBaseException().HResult -band 0xFFFF) -eq 33) { $held = $true } else { $l.Dispose(); Answer 'unknown' } } finally { $l.Dispose() }",
  '  if ($free) { try { [IO.File]::Delete($path) } catch {} }',
  '}',
  "if ($held) { Answer 'held' }",
  "Answer 'idle'"
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
async function askProbe(locksDir: string): Promise<ProbeAnswer | null> {
  const spec =
    process.platform === 'win32'
      ? {
          program: 'powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROBE],
          env: { ...process.env, ORCA_CODEX_THREAD_LOCKS: locksDir }
        }
      : { program: await perlProgram(), args: ['-e', PERL_PROBE, '--', locksDir] }
  const result = await runProcess({ ...spec, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null)
  if (!result || result.code !== 0 || result.timedOut) {
    return null
  }
  const answer = result.stdout.trim().split(/\r?\n/).at(-1)
  return answer === 'held' || answer === 'idle' || answer === 'unknown' ? answer : null
}

/**
 * Sweeps a thread-writer-locks folder as Codex does and says whether a Codex may be writing there:
 * a lock counts only while some process holds it (any user, PID namespace or Windows session), and
 * coordination already taken (a writer starting, a publication) counts too. Free locks are deleted,
 * so one a Codex takes later has no stale twin elsewhere. Without the helper nothing is deleted
 * and any lock file left in the folder counts, as before.
 */
async function sweepCodexThreadLocks(locksDir: string): Promise<boolean> {
  const answer = await askProbe(locksDir)
  if (answer !== null) {
    return answer !== 'idle'
  }
  const names = await readdir(locksDir).catch(() => null)
  return (
    names === null || names.some((name) => name.endsWith('.lock') && name !== COORDINATION_LOCK)
  )
}

// A thread lock only guards a writer while some process holds it: Codex leaves the file behind
// after a crash, and whenever releasing it finds coordination contended, so its mere presence
// proves nothing. A home with no lock folder never had a Codex writer.
export async function hasThreadWriter(home: string): Promise<boolean> {
  const locks = join(home, WRITER_LOCKS)
  const folder = await lstatIfPresent(locks)
  if (!folder || folder.isSymbolicLink()) {
    return false
  }
  return sweepCodexThreadLocks(locks)
}

// A thread lock in both folders as different files can't merge: the account's may have been taken
// since the sweep, and dropping either name would let a second writer lock the other.
export async function hasThreadLockConflict(
  accountHome: string,
  storeHome: string
): Promise<boolean> {
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
