; Repair persisted NSIS upgrade metadata. $installDir below is the literal orphaned value.
; Spec: upgrade-install-state.mjs. Close-app stays on the default CHECK_APP_RUNNING
; once $INSTDIR is a usable non-broad path (explorer / relocated daemon will not match).

!macro nsisUpgradeStateIsUnusable _value _out
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $0 ${_value}
  StrCpy ${_out} 0

  StrLen $1 $0
  ${Do}
    ${If} $1 == 0
      ${Break}
    ${EndIf}
    IntOp $1 $1 - 1
    StrCpy $2 $0 1 $1
    ${If} $2 != "\"
    ${AndIf} $2 != "/"
      IntOp $1 $1 + 1
      StrCpy $0 $0 $1
      ${Break}
    ${EndIf}
  ${Loop}

  StrCpy $1 ""
  StrCpy $2 0
  StrLen $4 $0
  ${Do}
    ${If} $2 >= $4
      ${Break}
    ${EndIf}
    StrCpy $3 $0 1 $2
    ${If} $3 == "/"
      StrCpy $3 "\"
    ${EndIf}
    StrCpy $1 "$1$3"
    IntOp $2 $2 + 1
  ${Loop}
  StrCpy $0 $1

  ${If} $0 == ""
    StrCpy ${_out} 1
  ${Else}
    StrCpy $1 $0 1
    ${If} $1 == "$$"
      StrCpy ${_out} 1
    ${Else}
      StrLen $1 $0
      ${If} $1 <= 3
        StrCpy ${_out} 1
      ${Else}
        StrCpy $1 $0 1 1
        ${If} $1 != ":"
          StrCpy ${_out} 1
        ${Else}
          StrCpy $1 $0 1 2
          ${If} $1 != "\"
          ${AndIf} $1 != "/"
            StrCpy ${_out} 1
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} ${_out} == 0
    StrCpy $1 $0 "" 2
    ${If} $1 == "\Users"
    ${OrIf} $1 == "/Users"
      StrCpy ${_out} 1
    ${Else}
      StrCpy $2 $1 7
      ${If} $2 == "\Users\"
      ${OrIf} $2 == "/Users/"
        StrCpy $1 $1 "" 7
        StrCpy $3 0
        StrLen $2 $1
        ${Do}
          ${If} $3 >= $2
            StrCpy ${_out} 1
            ${Break}
          ${EndIf}
          StrCpy $2 $1 1 $3
          ${If} $2 == "\"
          ${OrIf} $2 == "/"
            ${Break}
          ${EndIf}
          IntOp $3 $3 + 1
          StrLen $2 $1
        ${Loop}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} ${_out} == 0
    StrCpy $1 $0 "" -16
    ${If} $1 == "\AppData\Roaming"
      StrCpy ${_out} 1
    ${EndIf}
    StrCpy $1 $0 "" -14
    ${If} $1 == "\AppData\Local"
      StrCpy ${_out} 1
    ${EndIf}
    StrCpy $1 $0 "" -8
    ${If} $1 == "\AppData"
      StrCpy ${_out} 1
    ${EndIf}
    StrCpy $1 $0 "" -19
    ${If} $1 == "\AppData\Local\Orca"
      StrCpy ${_out} 1
    ${EndIf}
    StrCpy $1 $0 "" -21
    ${If} $1 == "\AppData\Roaming\Orca"
      StrCpy ${_out} 1
    ${EndIf}
  ${EndIf}

  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro nsisUpgradeParseUninstallExe _value _outExe
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 ${_value}
  StrCpy ${_outExe} ""
  StrCpy $1 $0 1
  ${If} $1 == '"'
    StrCpy $2 1
    ${Do}
      StrCpy $1 $0 1 $2
      ${If} $1 == ""
        ${Break}
      ${EndIf}
      ${If} $1 == '"'
        IntOp $3 $2 - 1
        StrCpy ${_outExe} $0 $3 1
        ${Break}
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
  ${Else}
    StrCpy $2 0
    StrLen $3 $0
    ${Do}
      ${If} $2 >= $3
        ${Break}
      ${EndIf}
      StrCpy $1 $0 4 $2
      ${If} $1 == ".exe"
      ${OrIf} $1 == ".EXE"
        IntOp $1 $2 + 4
        StrCpy ${_outExe} $0 $1
        ${Break}
      ${EndIf}
      IntOp $2 $2 + 1
    ${Loop}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro nsisUpgradeParentDir _file _out
  Push $0
  Push $1
  StrLen $0 ${_file}
  StrCpy ${_out} ""
  ${Do}
    ${If} $0 == 0
      ${Break}
    ${EndIf}
    IntOp $0 $0 - 1
    StrCpy $1 ${_file} 1 $0
    ${If} $1 == "\"
    ${OrIf} $1 == "/"
      StrCpy ${_out} ${_file} $0
      ${Break}
    ${EndIf}
  ${Loop}
  Pop $1
  Pop $0
!macroend

!macro customInit
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7

  !insertmacro GetDParameter $R0
  !insertmacro nsisUpgradeStateIsUnusable $R0 $R1

  ReadRegStr $R7 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R2 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !insertmacro nsisUpgradeParseUninstallExe $R2 $R3
  StrCpy $R4 ""
  ${If} $R3 != ""
    !insertmacro nsisUpgradeStateIsUnusable $R3 $R5
    ${If} $R5 == 0
    ${AndIf} ${FileExists} "$R3"
      !insertmacro nsisUpgradeParentDir $R3 $R4
      !insertmacro nsisUpgradeStateIsUnusable $R4 $R5
      ${If} $R5 == 1
        StrCpy $R4 ""
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $R0 != ""
  ${AndIf} $R1 == 0
    StrCpy $INSTDIR $R0
  ${Else}
    ${If} $R0 != ""
      StrCpy $INSTDIR $R7
    ${EndIf}
    !insertmacro nsisUpgradeStateIsUnusable $INSTDIR $R5
    StrCpy $R6 0
    ${If} $R5 == 0
      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        StrCpy $R6 1
      ${ElseIf} $R4 != ""
      ${AndIf} $INSTDIR == $R4
        StrCpy $R6 1
      ${EndIf}
    ${EndIf}
    ${If} $R6 == 0
      ${If} $R4 != ""
        StrCpy $INSTDIR $R4
      ${Else}
        StrCpy $INSTDIR "$LocalAppData\Programs\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  StrLen $R5 $INSTDIR
  ${Do}
    ${If} $R5 == 0
      ${Break}
    ${EndIf}
    IntOp $R5 $R5 - 1
    StrCpy $R6 $INSTDIR 1 $R5
    ${If} $R6 != "\"
    ${AndIf} $R6 != "/"
      IntOp $R5 $R5 + 1
      StrCpy $INSTDIR $INSTDIR $R5
      ${Break}
    ${EndIf}
  ${Loop}

  StrCpy $R5 ""
  StrCpy $R6 0
  StrLen $R1 $INSTDIR
  ${Do}
    ${If} $R6 >= $R1
      ${Break}
    ${EndIf}
    StrCpy $R1 $INSTDIR 1 $R6
    ${If} $R1 == "/"
      StrCpy $R1 "\"
    ${EndIf}
    StrCpy $R5 "$R5$R1"
    IntOp $R6 $R6 + 1
    StrLen $R1 $INSTDIR
  ${Loop}
  StrCpy $INSTDIR $R5

  !insertmacro nsisUpgradeStateIsUnusable $INSTDIR $R5
  ${If} $R5 == 1
    ${If} $R4 != ""
      StrCpy $INSTDIR $R4
    ${Else}
      StrCpy $INSTDIR "$LocalAppData\Programs\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}

  ${If} $R2 != ""
  ${AndIf} $R4 == ""
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
  ${EndIf}

  ${If} $R4 != ""
  ${AndIf} $R7 != $R4
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$R4"
  ${ElseIf} $R4 == ""
  ${AndIf} $R0 == ""
    !insertmacro nsisUpgradeStateIsUnusable $R7 $R5
    ${If} $R5 == 1
      !insertmacro nsisUpgradeStateIsUnusable $INSTDIR $R5
      ${If} $R5 == 0
        WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customUnInstallCheck
  ; Previous-uninstaller failure is not "app cannot be closed"; allow overwrite.
  ClearErrors
  StrCpy $R0 0
!macroend
