// The helper scripts that sweep and hold Codex's thread-writer-locks folders (see startProbe).
export const COORDINATION_LOCK = '.coordination.lock'
export const THREAD_LOCK_NAME =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\.lock$/i

// Codex's own stale-lock sweep (writer_lock.rs): with coordination held exclusively, every
// `<thread id>.lock` is opened read-write and tried without waiting; a free one is released and
// deleted. Codex takes coordination before opening a thread lock, so nothing can start between the
// listing and the try, and a Codex that needs coordination meanwhile waits for it instead of failing.
// Every folder's coordination is taken first; only the first folder's held locks count, and with
// ORCA_CODEX_THREAD_IDS (comma-separated) only those threads'. In `hold` mode an idle answer is
// `ready`, and coordination stays held until stdin closes.
export const PERL_PROBE = `
use Fcntl qw(:flock);
my ($mode, @dirs) = @ARGV;
my %only = map { lc($_) => 1 } grep { length } split /,/, ($ENV{ORCA_CODEX_THREAD_IDS} // '');
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
    $!{EWOULDBLOCK} ? ($held ||= $i == 0 && (!%only || $only{lc((split /\\./, $name)[0])})) : answer('unknown');
  }
}
answer('held') if $held;
answer('idle') if $mode ne 'hold';
print "ready\\n";
if ((<STDIN> // '') =~ /^first/) { close($coordination[0]); print "released\\n"; <STDIN> }
`

const hex = (n: number): string => '[0-9a-fA-F]'.repeat(n)
// Case-blind like THREAD_LOCK_NAME's /i.
const lockSuffix = '.[lL][oO][cC][kK]'
const SH_THREAD_LOCK_NAME = `${[8, 4, 4, 4, 12].map(hex).join('-')}${lockSuffix}|${hex(32)}${lockSuffix}`

// PERL_PROBE in sh + flock(1) (util-linux or BusyBox, both flock(2)), for a Linux without perl.
// Folder i's coordination is fd 3+i. A thread lock opens read-only so a vanished one isn't
// recreated; BusyBox flock can't tell contention from failure, so any failure counts as held.
// A failed `exec` redirect exits the shell, so each open is tried in a subshell or group first.
export const SH_PROBE = `
exec 2>/dev/null
command -v flock >/dev/null || { echo no-flock; exit 0; }
mode=$1; shift
answer() { echo "$1"; exit 0; }
fd=3
for dir in "$@"; do
  (: >>"$dir/${COORDINATION_LOCK}") || answer unknown
  eval "exec $fd>>\\"\\$dir/${COORDINATION_LOCK}\\""
  flock -n "$fd" || answer unknown
  fd=$((fd + 1))
done
held=0
i=0
for dir in "$@"; do
  [ -r "$dir" ] && [ -x "$dir" ] || answer unknown
  for path in "$dir"/*; do
    case "\${path##*/}" in ${SH_THREAD_LOCK_NAME}) ;; *) continue ;; esac
    lock=unopened
    { if flock -n 9; then flock -u 9; lock=free; else lock=held; fi; } 9<"$path"
    case $lock in
      free) rm -f -- "$path" ;;
      held)
        # Expansions only: no process per held lock while coordination is locked.
        if [ "$i" -eq 0 ]; then
          case \${ORCA_CODEX_THREAD_IDS:-} in
            '') held=1 ;;
            -) ;;
            *)
              stem=\${path##*/}
              stem=\${stem%%.*}
              case $stem in *[A-F]*) stem=$(printf '%s' "$stem" | tr 'A-F' 'a-f') ;; esac
              case ",$ORCA_CODEX_THREAD_IDS," in *",$stem,"*) held=1 ;; esac ;;
          esac
        fi ;;
      *) [ -e "$path" ] && answer unknown ;;
    esac
  done
  i=$((i + 1))
done
[ "$held" -eq 1 ] && answer held
[ "$mode" = hold ] || answer idle
echo ready
IFS= read -r line
case "$line" in first*) exec 3>&-; echo released; IFS= read -r line ;; esac
`

// The same sweep with LockFileEx (FileStream.Lock), sharing everything Codex's own opens share, so
// a Codex opening a lock meanwhile never meets a sharing violation. Lock violation (33) = contended;
// PowerShell wraps .NET errors, so it's read from the base exception.
export const POWERSHELL_PROBE = [
  "$ErrorActionPreference = 'Stop'",
  "$dirs = $env:ORCA_CODEX_THREAD_LOCKS -split '\\|'",
  'function Answer($a) { [Console]::Out.WriteLine($a); exit 0 }',
  '$coordination = @()',
  `foreach ($dir in $dirs) { try { $c = [IO.File]::Open((Join-Path $dir '${COORDINATION_LOCK}'), 'OpenOrCreate', 'ReadWrite', 'ReadWrite, Delete'); $c.Lock(0, 1); $coordination += $c } catch { Answer 'unknown' } }`,
  `$pattern = '${THREAD_LOCK_NAME.source}'`,
  '$held = $false',
  "$ids = @($env:ORCA_CODEX_THREAD_IDS -split ',' | Where-Object { $_ })",
  'for ($i = 0; $i -lt $dirs.Count; $i++) {',
  "  try { $paths = [IO.Directory]::GetFiles($dirs[$i]) } catch { Answer 'unknown' }",
  '  foreach ($path in $paths) {',
  '    if ([IO.Path]::GetFileName($path) -notmatch $pattern) { continue }',
  "    try { $l = [IO.File]::Open($path, 'Open', 'ReadWrite', 'ReadWrite, Delete') }",
  "    catch [IO.FileNotFoundException] { continue } catch { Answer 'unknown' }",
  '    $free = $false',
  "    try { $l.Lock(0, 1); $l.Unlock(0, 1); $free = $true } catch { if (($_.Exception.GetBaseException().HResult -band 0xFFFF) -eq 33) { if ($i -eq 0 -and ($ids.Count -eq 0 -or $ids -contains [IO.Path]::GetFileNameWithoutExtension($path))) { $held = $true } } else { $l.Dispose(); Answer 'unknown' } } finally { $l.Dispose() }",
  '    if ($free) { try { [IO.File]::Delete($path) } catch {} }',
  '  }',
  '}',
  "if ($held) { Answer 'held' }",
  "if ($env:ORCA_CODEX_HOLD -ne '1') { Answer 'idle' }",
  "[Console]::Out.WriteLine('ready')",
  // `first`: let go of the first folder's coordination only (it's about to be renamed).
  "if ([Console]::In.ReadLine() -eq 'first') { $coordination[0].Dispose(); [Console]::Out.WriteLine('released'); [void][Console]::In.ReadLine() }"
].join('\n')
