; Replaces electron-builder's running-app check, which the installer and the uninstaller both run
; before touching a file. The stock check starts Windows PowerShell up to five times (about 1.2 s
; each) and misses exactly one leftover process (electron-builder #10454: .Count on one CimInstance
; is empty in PowerShell 5.1), so the old uninstaller then fails on busy files and a silent update
; exits with code 2. This walks the process list in-process and stops every process whose image is
; under $INSTDIR\. The relocated terminal daemon runs from a copy outside $INSTDIR, so terminals
; survive; never fall back to matching Orca.exe by name, which would also stop that copy.
; An update gives the quitting app ORCA_UPDATE_EXIT_GRACE_MS to exit on its own (Orca's exit
; watchdog fires first, UPDATE_INSTALL_EXIT_TIMEOUT_MS in update-install-exit-watchdog.ts); a manual
; install asks first, then stops it at once. What still runs 2 s after that gets "cannot be closed",
; whose silent default quits before any file has been changed.
!define ORCA_UPDATE_EXIT_GRACE_MS 10000

!macro customCheckAppRunning
  System::Call "kernel32::GetCurrentProcessId() i .R9"
  ; $R8 is the tick count after which processes still running are terminated.
  System::Call "kernel32::GetTickCount() i .R8"
  IntOp $R8 $R8 + ${ORCA_UPDATE_EXIT_GRACE_MS}
  StrCpy $0 ""

  ${Do}
    System::Call "kernel32::GetTickCount() i .r1"
    IntOp $1 $1 - $R8
    ; $R7 counts processes still running from $INSTDIR on this pass.
    StrCpy $R7 0
    System::Call "kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .R0"
    ${If} $R0 <> -1
      ; PROCESSENTRY32W for the 32-bit installer: nine 4-byte fields, then WCHAR szExeFile[260].
      System::Alloc 556
      Pop $R1
      System::Call "*$R1(i 556)"
      System::Call "kernel32::Process32FirstW(p R0, p R1) i .R2"
      ${DoWhile} $R2 != 0
        System::Call "*$R1(i, i, i .R3)"
        ; Skip this process: an uninstaller run in place lives in $INSTDIR.
        ${If} $R3 != $R9
          ; PROCESS_QUERY_LIMITED_INFORMATION, which also reads an elevated process's image path.
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
                ${If} $1 >= 0
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
      System::Free $R1
      System::Call "kernel32::CloseHandle(p R0)"
    ${EndIf}

    ${If} $R7 == 0
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
    ${ElseIf} $1 >= 2000
      ; Typically an elevated process this installer may read but not terminate.
      ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDCANCEL`
        Quit
      ${EndIf}
      System::Call "kernel32::GetTickCount() i .R8"
    ${EndIf}

    Sleep 100
  ${Loop}
!macroend
