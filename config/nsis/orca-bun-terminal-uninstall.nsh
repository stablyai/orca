; This root is outside legacy profile-scoped pruning; runtime copies retain their shipped name.
!macro ORCA_UNINSTALL_BUN_TERMINAL_HOST
  ; Query and pin each process handle before termination; uncertainty retains the runtime files.
  StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::Exec /TIMEOUT=15000 `"$0" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop';try{if(!$$env:LOCALAPPDATA){throw 1};$$r=[IO.Path]::Combine($$env:LOCALAPPDATA,'Orca','terminal-daemon-host')+'\';$$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$$owned=@(Get-CimInstance Win32_Process|? Name -eq 'bun-runtime.exe'|%{if(!$$_.ExecutablePath){throw 1};if($$_.ExecutablePath.StartsWith($$r,[StringComparison]::OrdinalIgnoreCase)){if((Invoke-CimMethod -InputObject $$_ -MethodName GetOwnerSid).Sid -ne $$s){throw 1};$$p=Get-Process -Id $$_.ProcessId;$$null=$$p.Handle;if($$p.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -ne $$_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -or !$$p.Path.StartsWith($$r,[StringComparison]::OrdinalIgnoreCase)){throw 1};$$p}});foreach($$p in $$owned){if(!$$p.HasExited){$$p.Kill();if(!$$p.WaitForExit(5000)){throw 1}};$$p.Dispose()};exit 0}catch{exit 1}"`
  Pop $0
  ${if} $0 == 0
    RMDir /r "$LOCALAPPDATA\Orca\terminal-daemon-host"
  ${endIf}
!macroend
