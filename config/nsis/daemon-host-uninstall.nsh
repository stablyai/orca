; Clean up the relocated terminal daemon on a REAL uninstall.
;
; Why: the daemon host is deliberately copied to a distinct image name
; (orca-terminal-daemon.exe) under %LOCALAPPDATA%\Orca\daemon-host so that app
; UPDATES cannot kill it — that relocation is what keeps terminals alive across
; updates. The same design means a normal uninstall's process sweep and file
; removal both miss it, leaving an orphaned daemon plus its runtime copy behind.
;
; The ${isUpdated} guard is essential: electron-builder runs this uninstaller as
; part of uninstallOldVersion on EVERY update, and killing the daemon there would
; defeat the whole feature. Only clean up on a genuine uninstall.
;
; The image name and the LOCALAPPDATA folder name must stay in sync with
; DAEMON_HOST_EXE_NAME and LOCAL_HOST_ROOT_NAME in
; src/main/daemon/daemon-host-relocation.ts.

!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  ${if} ${isUpdated}
    ; Why: an A-era packaged CLI may still hold Orca.exe while its exact native launcher waits.
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { $$ErrorActionPreference='Stop'; $$app=[IO.Path]::GetFullPath($$args[0]); $$launcher=[IO.Path]::GetFullPath($$args[1]); $$comparison=[StringComparison]::OrdinalIgnoreCase; $$children=@(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and [String]::Equals([IO.Path]::GetFullPath($$_.ExecutablePath), $$app, $$comparison) }); $$launcherProofs=@(); foreach ($$child in $$children) { $$parent=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $$child.ParentProcessId) -ErrorAction SilentlyContinue; if ($$parent -and $$parent.ExecutablePath -and [String]::Equals([IO.Path]::GetFullPath($$parent.ExecutablePath), $$launcher, $$comparison)) { $$launcherProofs += [pscustomobject]@{ ProcessId=[int]$$parent.ProcessId; CreationDate=[string]$$parent.CreationDate } }; Stop-Process -Id $$child.ProcessId -Force -ErrorAction SilentlyContinue }; $$launcherDeadline=[DateTime]::UtcNow.AddSeconds(30); do { $$remaining=@($$launcherProofs | Where-Object { $$proof=$$_; $$current=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $$proof.ProcessId) -ErrorAction SilentlyContinue; $$current -and $$current.ExecutablePath -and [String]::Equals([IO.Path]::GetFullPath($$current.ExecutablePath), $$launcher, $$comparison) -and [String]::Equals([string]$$current.CreationDate, $$proof.CreationDate, [StringComparison]::Ordinal) }); if ($$remaining.Count -eq 0) { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $$launcherDeadline); if ($$remaining.Count -ne 0) { exit 20 }; $$lockDeadline=[DateTime]::UtcNow.AddSeconds(30); $$released=$$false; do { try { $$stream=[IO.File]::Open($$app, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $$stream.Dispose(); $$released=$$true } catch { Start-Sleep -Milliseconds 100 } } while (-not $$released -and [DateTime]::UtcNow -lt $$lockDeadline); if (-not $$released) { exit 21 } }" "$INSTDIR\Orca.exe" "$INSTDIR\resources\bin\orca.exe"`
    Pop $0
    ${if} $0 != 0
      DetailPrint "Orca update release proof failed with status $0."
      SetErrorLevel 2
      Quit
    ${endIf}
  ${else}
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'taskkill /F /IM orca-terminal-daemon.exe'
    ; Give the OS a moment to release the image lock before removing the tree.
    Sleep 500
    RMDir /r "$LOCALAPPDATA\Orca\daemon-host"
  ${endIf}
!macroend
