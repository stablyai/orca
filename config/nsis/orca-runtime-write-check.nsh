!macro ORCA_CHECK_RUNTIME_EXECUTABLE_WRITABLE
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Push $0
    ${Do}
      ; A process can lose its queryable Path before Windows releases its image mapping.
      System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p.r0'
      ${if} $0 != -1
        System::Call 'kernel32::CloseHandle(p r0)'
        ${Break}
      ${endIf}
      ${if} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY`
        ${Continue}
      ${endIf}
      SetErrorLevel 2
      Quit
    ${Loop}
    Pop $0
  ${endIf}
!macroend
