import { describe, expect, it } from 'vitest'

import { buildWslBridgeScript, buildWslLauncher } from '../main/cli/wsl-cli-scripts'
import { BOOLEAN_FLAGS, GLOBAL_FLAGS } from './args'
import { COMMAND_SPECS } from './specs'

// Why: PowerShell binds parameters by unique name prefix, so a bridge parameter whose name
// starts with a CLI flag swallows that flag and every argument after it.
const POWERSHELL_COMMON_PARAMETERS = [
  'Debug',
  'ErrorAction',
  'ErrorVariable',
  'InformationAction',
  'InformationVariable',
  'OutBuffer',
  'OutVariable',
  'PipelineVariable',
  'ProgressAction',
  'Verbose',
  'WarningAction',
  'WarningVariable'
]

const WINDOWS_LAUNCHER_PATH =
  'C:\\Users\\dev\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe'

function bridgeParameterNames(): string[] {
  return [...buildWslBridgeScript().matchAll(/^\s*\[string(?:\[\])?\]\$(\w+),?$/gm)].map(
    (match) => match[1]
  )
}

describe('WSL bridge parameters', () => {
  it('cannot prefix-capture a CLI flag', () => {
    const flags = new Set([
      ...GLOBAL_FLAGS,
      ...BOOLEAN_FLAGS,
      ...COMMAND_SPECS.flatMap((spec) => spec.allowedFlags)
    ])
    const parameters = [...bridgeParameterNames(), ...POWERSHELL_COMMON_PARAMETERS]

    const collisions = parameters.flatMap((parameter) =>
      [...flags]
        .filter((flag) => parameter.toLowerCase().startsWith(flag.toLowerCase()))
        .map((flag) => `--${flag} binds to -${parameter}`)
    )

    expect(collisions).toEqual([])
  })

  it('declares every parameter the launcher passes it', () => {
    const forwarded =
      buildWslLauncher(WINDOWS_LAUNCHER_PATH).split('$ORCA_BRIDGE_PS1_WIN"')[1] ?? ''
    const passed = [...forwarded.matchAll(/-([A-Za-z]\w*)/g)].map((match) => match[1])

    expect(passed).not.toHaveLength(0)
    expect(bridgeParameterNames()).toEqual(expect.arrayContaining(passed))
  })
})
