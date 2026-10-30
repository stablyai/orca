import { expect, it } from 'vitest'
import { isWslDistroNotRunningRefusal } from '../../shared/wsl-distro-not-running-refusal'
import { WslDistroStoppedError, WslDistroUnverifiableError } from './wsl-unc-access-gate'

it('recognizes both gate refusals as they arrive over IPC, and nothing else', () => {
  const overIpc = (error: Error): Error =>
    new Error(
      `Error invoking remote method 'preflight:detectAgents': ${error.name}: ${error.message}`
    )
  expect(isWslDistroNotRunningRefusal(overIpc(new WslDistroStoppedError('Ubuntu')))).toBe(true)
  expect(isWslDistroNotRunningRefusal(overIpc(new WslDistroUnverifiableError('Ubuntu')))).toBe(true)
  expect(isWslDistroNotRunningRefusal(new Error('wsl.exe timed out'))).toBe(false)
})

it('does not depend on how the refusal words its remedy', () => {
  expect(
    isWslDistroNotRunningRefusal("WSL distro 'Ubuntu' is not running. Open a terminal to start it.")
  ).toBe(true)
  expect(isWslDistroNotRunningRefusal("WSL didn't answer whether 'Ubuntu' is running.")).toBe(true)
  expect(isWslDistroNotRunningRefusal('Orca is not running.')).toBe(false)
})
