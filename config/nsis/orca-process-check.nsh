; Defining the hook suppresses electron-builder's process-info declarations.
!include "getProcessInfo.nsh"
Var pid
Var /GLOBAL IsPowerShellAvailable

!macro customCheckAppRunning
  ; Restricted permits inline commands; test the process query rather than script-file policy.
  ; Match upstream FIND/KILL's profile behavior so the probe cannot skip a failing profile.
  nsExec::Exec `"$PowerShellPath" -Command "try { Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"`
  Pop $0
  ; Launch errors, timeouts, and failed queries retain upstream's image-name fallback.
  StrCpy $IsPowerShellAvailable 1
  ${if} $0 == 0
    StrCpy $IsPowerShellAvailable 0
  ${endIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
