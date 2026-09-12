; electron-builder NSIS hooks for the Orca Windows installer.
;
; electron-builder accepts exactly ONE `nsis.include` file, so every customInstall /
; customUnInstall hook Orca needs lives here.

; Native process checks avoid false success when GPO blocks Windows PowerShell
; while returning exit code 0 (issues #13924, #16528).
; customCheckAppRunning also prevents electron-builder from expanding its
; PowerShell-based probe; nsProcess is already bundled by electron-builder.
!macro customCheckAppRunning
  ${if} ${isUpdated}
    ; Preserve electron-builder's update grace period.
    Sleep 300
  ${endIf}

  orca_check_again:
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 != 0
  ${andIf} $R0 != 603
    Goto orca_check_failed
  ${endIf}
  ${if} $R0 == 0
    ${if} ${isUpdated}
      Sleep 1000
    ${else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK orca_stop_app
      ${nsProcess::Unload}
      Quit
    ${endIf}

    orca_stop_app:

    DetailPrint "$(appClosing)"
    ; Allow state to flush before forcing termination.
    ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    Sleep 300

    StrCpy $R1 0

    orca_wait_loop:
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 603
        Goto orca_not_running
      ${endIf}
      ${if} $R0 != 0
        Goto orca_check_failed
      ${endIf}

      Sleep 1000
      ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0

      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 603
        Goto orca_not_running
      ${endIf}
      ${if} $R0 != 0
        Goto orca_check_failed
      ${endIf}

      DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
      Sleep 2000

      IntOp $R1 $R1 + 1
      ; An elevated process may require manual closure.
      ${if} $R1 > 1
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY orca_wait_loop
        ${nsProcess::Unload}
        Quit
      ${endIf}
      Goto orca_wait_loop

    orca_not_running:
  ${endIf}

  Goto orca_check_done

  orca_check_failed:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Unable to check whether ${PRODUCT_NAME} is running (process query error $R0). Close ${PRODUCT_NAME} and retry." /SD IDCANCEL IDRETRY orca_check_again
    ${nsProcess::Unload}
    SetErrorLevel 2
    Quit

  orca_check_done:
  ${nsProcess::Unload}
!macroend

; ---------------------------------------------------------------------------
; Markdown "Open with Orca" (issue #10138)
;
; Why hand-rolled instead of electron-builder's `fileAssociations` on Windows:
; app-builder-lib emits !insertmacro APP_ASSOCIATE, whose first line is
;   WriteRegStr SHELL_CONTEXT "Software\Classes\.md" "" "<ProgID>"
; That overwrites whichever editor currently owns .md, with no backup, for every
; existing user on their next UPDATE - and APP_UNASSOCIATE never restores it, so
; uninstalling Orca would leave .md pointing at a deleted ProgID.
;
; These writes are additive only. Registering a ProgID plus an OpenWithProgids
; hint and an Applications\<exe>\SupportedTypes entry puts Orca in Explorer's
; "Open with" list and in "Choose another app", while the default handler stays
; exactly where the user left it. Never add a `Software\Classes\.<ext>` default
; value here.
;
; MARKDOWN_PROGID must stay in sync with the extension list handled by
; isMarkdownDocumentName() in src/main/ipc/markdown-documents.ts.
; ---------------------------------------------------------------------------
!define MARKDOWN_PROGID "Orca.Markdown"

!macro ORCA_REGISTER_MARKDOWN_OPEN_WITH EXT
  WriteRegNone SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "${MARKDOWN_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
!macroend

!macro ORCA_UNREGISTER_MARKDOWN_OPEN_WITH EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "${MARKDOWN_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}"
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MARKDOWN_PROGID}" "" "Markdown Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MARKDOWN_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MARKDOWN_PROGID}\shell\open" "" "Open with ${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MARKDOWN_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  !insertmacro ORCA_REGISTER_MARKDOWN_OPEN_WITH ".md"
  !insertmacro ORCA_REGISTER_MARKDOWN_OPEN_WITH ".markdown"
  !insertmacro ORCA_REGISTER_MARKDOWN_OPEN_WITH ".mdx"
  ; Why: Explorer caches the association list until told otherwise.
  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend

; ---------------------------------------------------------------------------
; Clean up the relocated terminal daemon on a REAL uninstall.
;
; Why: the daemon host is deliberately copied OUT of the install dir into
; %LOCALAPPDATA%\Orca\daemon-host so that app UPDATES cannot kill it —
; electron-builder's kill sweep selects processes whose image path is under
; $INSTDIR, and that relocation is what keeps terminals alive across updates.
; The same design means a normal uninstall's process sweep and file removal both
; miss it, leaving an orphaned daemon plus its runtime copy behind.
;
; The ${isUpdated} guard is essential: electron-builder runs this uninstaller as
; part of uninstallOldVersion on EVERY update, and killing the daemon there would
; defeat the whole feature. Only clean up on a genuine uninstall.
;
; The LOCALAPPDATA folder name must stay in sync with LOCAL_HOST_ROOT_NAME in
; src/main/daemon/daemon-host-relocation.ts. See
; docs/reference/windows-daemon-host-relocation.md.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    Push $1
    Push $2
    ; The host exe is a verbatim copy of the app exe, so the app's own image name
    ; reaches it; the second name covers hosts left by builds that renamed the copy.
    ; Filtered to the current user like upstream's per-user KILL_PROCESS, so an
    ; elevated machine-wide uninstall cannot reach another logged-on user's session.
    ; NSIS expands USERNAME itself: routing through cmd.exe only to get %USERNAME%
    ; would add two interpreter spawns to the uninstall path for nothing.
    ReadEnvStr $1 USERNAME
    ${if} $1 == ""
      ; Measured: taskkill rejects an empty filter value outright ("The search filter
      ; cannot be recognized") and kills nothing, so with no USERNAME to scope by,
      ; kill unfiltered rather than not at all. USERNAME is set in every session an
      ; uninstaller runs in, so this is a backstop, not the expected path.
      StrCpy $2 ""
    ${else}
      StrCpy $2 '/FI "USERNAME eq $1"'
    ${endIf}
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" $2'
    Pop $0
    nsExec::Exec 'taskkill /F /IM "orca-terminal-daemon.exe" $2'
    Pop $0
    Pop $2
    Pop $1
    Pop $0
    ; Give the OS a moment to release the image lock before removing the tree.
    Sleep 500
    RMDir /r "$LOCALAPPDATA\Orca\daemon-host"
  ${endIf}
  ; Why outside the ${isUpdated} guard: customInstall rewrites these on every update, so
  ; dropping them during uninstallOldVersion is correct and keeps the pair symmetric.
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MARKDOWN_PROGID}"
  !insertmacro ORCA_UNREGISTER_MARKDOWN_OPEN_WITH ".md"
  !insertmacro ORCA_UNREGISTER_MARKDOWN_OPEN_WITH ".markdown"
  !insertmacro ORCA_UNREGISTER_MARKDOWN_OPEN_WITH ".mdx"
  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend
