; Another Orca install for this Windows user still runs the shared ~/.orca/agent-hooks scripts, so
; its agents' hook entries must stay. Every channel shares one app GUID, so the other install can
; only be the other registration: per-user (HKCU) beside per-machine (HKLM), or the reverse.

!define ORCA_OTHER_INSTALL_HKCU 0x80000001
!define ORCA_OTHER_INSTALL_HKLM 0x80000002
; KEY_READ | KEY_WOW64_64KEY: System::Call ignores SetRegView, so name the 64-bit view the uninstaller uses.
!define ORCA_OTHER_INSTALL_KEY_READ_64 0x20119
!define ORCA_ERROR_FILE_NOT_FOUND 2

; OUT: "none", "other" (a different install dir that still has the app), or "unknown" (a read
; failed, or a registration names no location).
!macro ORCA_CHECK_ONE_REGISTRATION HKEY HIVE OUT
  ${if} ${OUT} == "none"
    System::Call 'advapi32::RegOpenKeyEx(p ${HKEY}, t "${INSTALL_REGISTRY_KEY}", i 0, i ${ORCA_OTHER_INSTALL_KEY_READ_64}, *p .R6) i .R7'
    ${if} $R7 == 0
      System::Call 'advapi32::RegCloseKey(p R6)'
      ReadRegStr $R5 ${HIVE} "${INSTALL_REGISTRY_KEY}" InstallLocation
      ; Our own registration names $INSTDIR; LogicLib == compares case-insensitively.
      ${if} $R5 == ""
        ; A registration with no readable location could be another install: keep the hooks.
        StrCpy ${OUT} "unknown"
      ${elseIf} $R5 != $INSTDIR
      ${andIf} $R5 != "$INSTDIR\"
      ${andIf} ${FileExists} "$R5\${APP_EXECUTABLE_FILENAME}"
        StrCpy ${OUT} "other"
      ${endIf}
    ${elseIf} $R7 != ${ORCA_ERROR_FILE_NOT_FOUND}
      StrCpy ${OUT} "unknown"
    ${endIf}
  ${endIf}
!macroend

!macro ORCA_OTHER_INSTALL_STATE OUT
  Push $R5
  Push $R6
  Push $R7
  StrCpy ${OUT} "none"
  !insertmacro ORCA_CHECK_ONE_REGISTRATION ${ORCA_OTHER_INSTALL_HKCU} HKCU ${OUT}
  !insertmacro ORCA_CHECK_ONE_REGISTRATION ${ORCA_OTHER_INSTALL_HKLM} HKLM ${OUT}
  Pop $R7
  Pop $R6
  Pop $R5
!macroend
