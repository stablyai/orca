; Replaces electron-builder's running-app check, which the installer and the uninstaller both run
; before touching a file. With our capability probe it started Windows PowerShell up to six times
; (about 1-1.5 s each) and missed exactly one leftover process (electron-builder #10454: .Count on
; one CimInstance is empty in PowerShell 5.1), so the old uninstaller then failed on busy files and
; a silent update exited with code 2. This walks the process list in-process and stops every
; process whose image is under $INSTDIR\. The terminal daemon normally runs from a relocated copy
; outside $INSTDIR, so terminals survive; never fall back to matching Orca.exe by name, which would
; also stop that copy. A daemon that could not be relocated runs from $INSTDIR and is stopped like
; any other process: it holds the files being replaced, so sparing it would fail the update.
; An update gives the quitting app ORCA_UPDATE_EXIT_GRACE_MS to exit on its own (Orca's exit
; watchdog fires first: WINDOWS_UPDATE_INSTALL_EXIT_TIMEOUT_MS, update-install-exit-watchdog.ts);
; a manual install asks first, then stops it at once. What still runs 2 s after that gets "cannot
; be closed", whose silent default quits before any file has been changed.
; A process this non-elevated installer cannot open (UAC-elevated, or another user's) is skipped,
; as the stock check skipped one whose path it could not read; the uninstaller's rollback still
; guards the files it holds.
!define ORCA_UPDATE_EXIT_GRACE_MS 10000

; PROCESSENTRY32W below is laid out for the 32-bit installer electron-builder builds.
!if ${NSIS_PTR_SIZE} != 4
  !error "orca-process-check.nsh assumes a 32-bit NSIS (PROCESSENTRY32W is 556 bytes)"
!endif

!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  System::Call "kernel32::GetCurrentProcessId() i .R9"
  ; $R8 is the tick count after which processes still running are terminated.
  System::Call "kernel32::GetTickCount() i .R8"
  IntOp $R8 $R8 + ${ORCA_UPDATE_EXIT_GRACE_MS}
  StrCpy $0 ""
  ; $2 is the tick count of the first pass that terminated something.
  StrCpy $2 ""

  ${Do}
    ; $3 is this pass's start; $1 is how far past the grace deadline it is.
    System::Call "kernel32::GetTickCount() i .r3"
    IntOp $1 $3 - $R8
    ; $R7 counts processes still running from $INSTDIR on this pass.
    StrCpy $R7 0
    System::Call "kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .R0"
    ; PROCESSENTRY32W: nine 4-byte fields, then WCHAR szExeFile[260].
    System::Alloc 556
    Pop $R1
    ${If} $R1 = 0
      ; Out of memory: count nothing rather than read through a null buffer.
      ${If} $R0 <> -1
        System::Call "kernel32::CloseHandle(p R0)"
      ${EndIf}
      StrCpy $R0 -1
    ${EndIf}
    ${If} $R0 <> -1
      System::Call "*$R1(i 556)"
      System::Call "kernel32::Process32FirstW(p R0, p R1) i .R2"
      ${DoWhile} $R2 != 0
        System::Call "*$R1(i, i, i .R3)"
        ; Skip this process: an uninstaller run in place lives in $INSTDIR.
        ${If} $R3 != $R9
          ; PROCESS_QUERY_LIMITED_INFORMATION; fails for a process this installer may not open.
          System::Call "kernel32::OpenProcess(i 0x1000, i 0, i R3) p .R4"
          ${If} $R4 != 0
            System::Call "kernel32::QueryFullProcessImageNameW(p R4, i 0, w .R5, *i ${NSIS_MAX_STRLEN}) i .R6"
            System::Call "kernel32::CloseHandle(p R4)"
            ${If} $R6 != 0
              ; StrCmp is case-insensitive; the separator keeps a sibling like "Orca-old" out.
              StrLen $R6 "$INSTDIR\"
              StrCpy $R5 $R5 $R6
              ${If} $R5 == "$INSTDIR\"
                IntOp $R7 $R7 + 1
                ; $0 is set only after a pass that found something (and, on a manual install,
                ; after the user agreed), so nothing is terminated before that.
                ${If} $1 >= 0
                ${AndIf} $0 != ""
                  ${If} $2 == ""
                    StrCpy $2 $3
                  ${EndIf}
                  ; PROCESS_TERMINATE
                  System::Call "kernel32::OpenProcess(i 1, i 0, i R3) p .R4"
                  ${If} $R4 != 0
                    System::Call "kernel32::TerminateProcess(p R4, i 1)"
                    System::Call "kernel32::CloseHandle(p R4)"
                  ${EndIf}
                ${EndIf}
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
        System::Call "kernel32::Process32NextW(p R0, p R1) i .R2"
      ${Loop}
      System::Call "kernel32::CloseHandle(p R0)"
    ${EndIf}
    ${If} $R1 <> 0
      System::Free $R1
    ${EndIf}

    ; Only a scan that ran and found nothing ends the check; a failed snapshot is retried.
    ${If} $R7 == 0
    ${AndIf} $R0 <> -1
      ${ExitDo}
    ${EndIf}

    ${If} $0 == ""
      StrCpy $0 "running"
      ${IfNot} ${isUpdated}
        ${If} ${Cmd} `MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDCANCEL`
          Quit
        ${EndIf}
        System::Call "kernel32::GetTickCount() i .R8"
      ${EndIf}
      DetailPrint "$(appClosing)"
    ${ElseIf} $2 != ""
      ; A fresh scan 2 s after the first termination still finds something: TerminateProcess was
      ; refused or the app keeps starting again.
      IntOp $4 $3 - $2
      ${If} $4 >= 2000
        ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDCANCEL`
          Quit
        ${EndIf}
        System::Call "kernel32::GetTickCount() i .R8"
        StrCpy $2 ""
      ${EndIf}
    ${ElseIf} $R0 = -1
    ${AndIf} $1 >= 2000
      ; The process list cannot be read at all.
      ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDCANCEL`
        Quit
      ${EndIf}
      System::Call "kernel32::GetTickCount() i .R8"
    ${EndIf}

    Sleep 100
  ${Loop}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
