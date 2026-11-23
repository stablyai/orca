# Start independent workers in parallel

Each `worker-start` waits until its agent is ready (often about 10 seconds). Many agents run their
own tool calls one after another, so separate tool calls do not overlap. Start a group of up to
about 4 from one shell command instead, then start the rest as that group returns.

Rules:

- Put each spec in its own file and pass `--spec-file`, so no argument needs quoting.
- Give each start its own receipt file and error file, and collect each exit status.
- Read every receipt, including after a failure: a receipt with `next`, `failedStage` or recovery
  steps is handled exactly as for a single start. A missing or cut-off receipt is an unknown
  outcome: check `ORCA orchestration worker-list --environment local` before anything else, and
  never start that spec again blindly.
- Use the form for the shell that runs the CLI. `ORCA` stands for the executable path you resolved;
  quote it if it contains spaces.

POSIX shells (bash, zsh; also WSL and SSH hosts):

```sh
d=$(mktemp -d)
ORCA orchestration worker-start --environment local --spec-file w1.md --worktree new-child --name w1 --agent default >"$d/w1.out" 2>"$d/w1.err" & p1=$!
ORCA orchestration worker-start --environment local --spec-file w2.md --worktree new-child --name w2 --agent default >"$d/w2.out" 2>"$d/w2.err" & p2=$!
s=0; wait "$p1" || s=$?; echo "w1 exit $s"
s=0; wait "$p2" || s=$?; echo "w2 exit $s"
for f in "$d"/*; do echo "== $f"; cat "$f"; done
```

Windows PowerShell (5.1 or later; from cmd, run `powershell -NoProfile -Command` with this):

```powershell
$d = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid()))
$starts = foreach ($n in 'w1', 'w2') {
  $p = Start-Process -FilePath 'ORCA' -NoNewWindow -PassThru -WorkingDirectory (Get-Location) `
    -ArgumentList "orchestration worker-start --environment local --spec-file $n.md --worktree new-child --name $n --agent default" `
    -RedirectStandardOutput "$d\$n.out" -RedirectStandardError "$d\$n.err"
  $null = $p.Handle
  [pscustomobject]@{ Name = $n; Process = $p }
}
foreach ($s in $starts) { $s.Process.WaitForExit(); "$($s.Name) exit $($s.Process.ExitCode)" }
Get-ChildItem $d | ForEach-Object { "== $($_.Name)"; Get-Content $_.FullName }
```
