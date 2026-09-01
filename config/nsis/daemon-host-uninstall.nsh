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
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'taskkill /F /IM orca-terminal-daemon.exe'
    ; Give the OS a moment to release the image lock before removing the tree.
    Sleep 500
    RMDir /r "$LOCALAPPDATA\Orca\daemon-host"
  ${endIf}
!macroend

; Why: ensure the install directory carries an explicit read/execute grant for
; ALL RESTRICTED APPLICATION PACKAGES. When missing (e.g. from custom unpacking
; or protected DACL inheritance), Chromium renderer and GPU processes fail to
; start with STATUS_BREAKPOINT since their AppContainer cannot read the binaries.
!macro customInstall
  nsExec::Exec '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-2:(OI)(CI)(RX)'
  Pop $0
  ${If} $0 != "0"
    DetailPrint "Failed to grant restricted AppContainer read access: $0"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Orca was installed, but Windows could not finish configuring access to its files (error $0). Orca may not start; retry the installer or contact support."
    ${EndIf}
  ${EndIf}
!macroend
