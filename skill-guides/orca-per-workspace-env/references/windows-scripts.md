# Windows local-side scripts

Load this when the user's desktop is Windows and you are scaffolding the local-side scripts. A bare
`.sh` will not execute there. Either require WSL or Git Bash and point `orca.yaml` at a launcher such
as `bash ./scripts/orca-vm/<name>.sh` through a `.cmd` file, or scaffold PowerShell equivalents.

The remote-side commands you run inside the Linux environment stay bash regardless of the desktop OS.

```powershell
#requires -Version 5
$ErrorActionPreference = 'Stop'
# resolve env→state→fallback; run the provider CLI / ssh the same way;
# capture provider output; build the result object for the chosen mode and write ONE line of JSON to stdout.
# Orca-server mode: @{ schemaVersion=1; pairingCode=$pairingCode; projectRoot=$projectRoot; userData=@{...} }
# SSH mode:        @{ schemaVersion=1; connection=@{ type="ssh"; projectRoot=$projectRoot;
#                     target=@{ label=$label; host=$host; port=$port; username=$user } } }
($result | ConvertTo-Json -Compress -Depth 6)
# progress/errors → Write-Error / the error stream, never stdout.
```

The doctor's executable-bit check is a POSIX concept and is skipped on Windows, so a script that is
unusable on the user's machine for a different reason still has to be caught by the `--provision`
self-test.
