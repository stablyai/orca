; Uninstall twin of removeWindowsPathEntry (src/main/cli/cli-path-registration.ts): drop this
; install's command directory from the user PATH and keep every other entry byte-for-byte.
; Native registry calls only: no PowerShell or reg.exe at uninstall (Windows EDR rules).

!define ORCA_HKEY_CURRENT_USER 0x80000001
!define ORCA_KEY_QUERY_VALUE 0x20019
!define ORCA_REG_SZ 1
!define ORCA_REG_EXPAND_SZ 2

!macro ORCA_REMOVE_USER_PATH_ENTRY DIR
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
  StrCpy $R9 "${DIR}"
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrLen $R1 $R0
  IntOp $R2 ${NSIS_MAX_STRLEN} - 1
  ; A PATH at the string limit may have been truncated on read; writing it back would lose entries.
  ${if} $R0 != ""
  ${andIf} $R1 < $R2
    ; Read the value type so an expandable PATH stays expandable; an unknown type skips the edit.
    StrCpy $R8 ""
    System::Call 'advapi32::RegOpenKeyEx(p ${ORCA_HKEY_CURRENT_USER}, t "Environment", i 0, i ${ORCA_KEY_QUERY_VALUE}, *p .R6) i .R7'
    ${if} $R7 == 0
      System::Call 'advapi32::RegQueryValueEx(p R6, t "Path", p 0, *i .R4, p 0, p 0) i .R7'
      System::Call 'advapi32::RegCloseKey(p R6)'
      ${if} $R7 == 0
        StrCpy $R8 $R4
      ${endIf}
    ${endIf}
    StrCpy $R3 ""
    StrCpy $R4 ""
    StrCpy $R5 0
    ; $R2: no entry kept yet; $R7: an entry was removed.
    StrCpy $R2 1
    StrCpy $R7 0
    ${Do}
      StrCpy $R6 $R0 1 $R5
      ${if} $R6 == ";"
      ${orIf} $R6 == ""
        ; LogicLib == is case-insensitive, as Windows paths are.
        ${if} $R4 == $R9
        ${orIf} $R4 == "$R9\"
          StrCpy $R7 1
        ${elseIf} $R2 == 1
          StrCpy $R3 $R4
          StrCpy $R2 0
        ${else}
          StrCpy $R3 "$R3;$R4"
        ${endIf}
        StrCpy $R4 ""
        ${if} $R6 == ""
          ${ExitDo}
        ${endIf}
      ${else}
        StrCpy $R4 "$R4$R6"
      ${endIf}
      IntOp $R5 $R5 + 1
    ${Loop}
    ${if} $R7 == 1
    ${andIf} $R8 != ""
      ${if} $R3 == ""
        DeleteRegValue HKCU "Environment" "Path"
      ${elseIf} $R8 == ${ORCA_REG_EXPAND_SZ}
        WriteRegExpandStr HKCU "Environment" "Path" $R3
      ${elseIf} $R8 == ${ORCA_REG_SZ}
        WriteRegStr HKCU "Environment" "Path" $R3
      ${endIf}
      ; Tell Explorer, so new shells stop seeing the removed entry.
      SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
    ${endIf}
  ${endIf}
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
!macroend
