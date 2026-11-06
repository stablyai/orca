; electron-builder accepts one nsis.include; keep every customInstall/customUnInstall hook here.

!include "${__FILEDIR__}\orca-process-check.nsh"
!include "${__FILEDIR__}\orca-user-path-cleanup.nsh"
!include "${__FILEDIR__}\orca-other-install-check.nsh"

; #10138/#23225: electron-builder’s APP_ASSOCIATE overwrites the extension’s default without backup,
; and APP_UNASSOCIATE never restores it. Register only additive ProgID/OpenWithProgids/SupportedTypes
; entries; never write the extension’s default handler. Sync extensions with isOsOpenedDocumentName().
!define MARKDOWN_PROGID "Orca.Markdown"
!define TABULAR_PROGID "Orca.Tabular"

!macro ORCA_REGISTER_DOCUMENT_OPEN_WITH EXT PROGID
  WriteRegNone SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
!macroend

!macro ORCA_UNREGISTER_DOCUMENT_OPEN_WITH EXT PROGID
  DeleteRegValue SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}"
!macroend

!macro ORCA_REGISTER_DOCUMENT_PROGID PROGID NAME
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open" "" "Open with ${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro customInstall
  !insertmacro ORCA_REGISTER_DOCUMENT_PROGID "${MARKDOWN_PROGID}" "Markdown Document"
  !insertmacro ORCA_REGISTER_DOCUMENT_PROGID "${TABULAR_PROGID}" "Tabular Document"
  !insertmacro ORCA_REGISTER_DOCUMENT_OPEN_WITH ".md" "${MARKDOWN_PROGID}"
  !insertmacro ORCA_REGISTER_DOCUMENT_OPEN_WITH ".markdown" "${MARKDOWN_PROGID}"
  !insertmacro ORCA_REGISTER_DOCUMENT_OPEN_WITH ".mdx" "${MARKDOWN_PROGID}"
  !insertmacro ORCA_REGISTER_DOCUMENT_OPEN_WITH ".csv" "${TABULAR_PROGID}"
  !insertmacro ORCA_REGISTER_DOCUMENT_OPEN_WITH ".tsv" "${TABULAR_PROGID}"
  ; Why: Explorer caches the association list until told otherwise.
  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend

; Relocated hosts escape $INSTDIR’s process/file sweep, surviving updates but requiring real-uninstall cleanup.
; Keep ${isUpdated}: uninstallOldVersion runs this hook on every update and must preserve terminals.
; Sync LOCALAPPDATA root with LOCAL_HOST_ROOT_NAME in src/main/daemon/daemon-host-relocation.ts;
; see docs/reference/windows-daemon-host-relocation.md.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    Push $1
    Push $2
    ; The verbatim app exe and an older renamed host both need cleanup, scoped to the current user
    ; like upstream KILL_PROCESS. NSIS expands USERNAME directly, avoiding two cmd.exe spawns.
    ReadEnvStr $1 USERNAME
    ${if} $1 == ""
      ; taskkill rejects an empty user filter and kills nothing. Fall back unfiltered if the normally set USERNAME is absent.
      StrCpy $2 ""
    ${else}
      StrCpy $2 '/FI "USERNAME eq $1"'
    ${endIf}
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" $2'
    Pop $0
    nsExec::Exec 'taskkill /F /IM "orca-terminal-daemon.exe" $2'
    Pop $0
    ; WSL hosts: the detached wsl.exe holders and each host's server keep their distros running. Orca
    ; ends only the holders its profile recorded, each checked by pid, start time and command line.
    ; The last install for this user also stops each recorded host's server in a running distro: the
    ; HKCU/HKLM twin shares this userData, its host records and those servers, so it keeps them.
    ; Only a userData with a holder folder or WSL host records launches it: everyone who never ran a
    ; WSL host sees nothing here. These are the folders Electron's userData (app.getName()) can be, as the
    ; deleteAppData step lists them; a custom --user-data-dir can't be known here.
    ; Sync the flags with WSL_HOLDER_UNINSTALL_FLAG and WSL_SERVER_UNINSTALL_FLAG in
    ; src/main/startup/wsl-holder-uninstall-preflight.ts.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endIf}
    StrCpy $1 ""
    StrCpy $2 ""
    ${if} ${FileExists} "$APPDATA\${APP_FILENAME}\wsl-distro-holders\*.json"
      StrCpy $1 "1"
    ${endIf}
    ${if} ${FileExists} "$APPDATA\${APP_FILENAME}\orca-wsl-host-deployments.json"
      StrCpy $2 "1"
    ${endIf}
    !ifdef APP_PRODUCT_FILENAME
      ${if} ${FileExists} "$APPDATA\${APP_PRODUCT_FILENAME}\wsl-distro-holders\*.json"
        StrCpy $1 "1"
      ${endIf}
      ${if} ${FileExists} "$APPDATA\${APP_PRODUCT_FILENAME}\orca-wsl-host-deployments.json"
        StrCpy $2 "1"
      ${endIf}
    !endif
    !ifdef APP_PACKAGE_NAME
      ${if} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\wsl-distro-holders\*.json"
        StrCpy $1 "1"
      ${endIf}
      ${if} ${FileExists} "$APPDATA\${APP_PACKAGE_NAME}\orca-wsl-host-deployments.json"
        StrCpy $2 "1"
      ${endIf}
    !endif
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
    ${if} $2 == "1"
      !insertmacro ORCA_OTHER_INSTALL_STATE $2
    ${endIf}
    ${if} $2 == "none"
      nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --orca-uninstall-release-wsl-holders --orca-uninstall-stop-wsl-servers'
      Pop $0
    ${elseIf} $1 == "1"
      nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --orca-uninstall-release-wsl-holders'
      Pop $0
    ${endIf}
    ; Agent hook entries call the ~/.orca\agent-hooks scripts by bare path. Those scripts outlive the
    ; app, but once that folder is removed every agent fails a hook per event, so the last Orca for
    ; this user takes the entries out. Another install, or an unreadable registry, keeps them.
    ; Best effort: the exit code never blocks uninstall.
    ; Sync the flag with AGENT_HOOKS_UNINSTALL_FLAG in src/main/startup/agent-hooks-uninstall-preflight.ts.
    !insertmacro ORCA_OTHER_INSTALL_STATE $1
    ${if} $1 == "none"
      nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --orca-uninstall-remove-agent-hooks'
      Pop $0
    ${endIf}
    ; The `orca` command's PATH entry (Settings → Command line) would otherwise outlive the app.
    !insertmacro ORCA_REMOVE_USER_PATH_ENTRY "$INSTDIR\resources\bin"
    Pop $2
    Pop $1
    Pop $0
    ; Give the OS a moment to release the image lock before removing the tree.
    Sleep 500
    RMDir /r "$LOCALAPPDATA\Orca\daemon-host"
    RMDir /r "$LOCALAPPDATA\Orca\daemon-host-profiles"
  ${endIf}
  ; customInstall rewrites associations on every update, so remove them during uninstallOldVersion too.
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MARKDOWN_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${TABULAR_PROGID}"
  !insertmacro ORCA_UNREGISTER_DOCUMENT_OPEN_WITH ".md" "${MARKDOWN_PROGID}"
  !insertmacro ORCA_UNREGISTER_DOCUMENT_OPEN_WITH ".markdown" "${MARKDOWN_PROGID}"
  !insertmacro ORCA_UNREGISTER_DOCUMENT_OPEN_WITH ".mdx" "${MARKDOWN_PROGID}"
  !insertmacro ORCA_UNREGISTER_DOCUMENT_OPEN_WITH ".csv" "${TABULAR_PROGID}"
  !insertmacro ORCA_UNREGISTER_DOCUMENT_OPEN_WITH ".tsv" "${TABULAR_PROGID}"
  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend
