import { describe, expect, it, vi } from 'vitest'
import { formatServeRuntimeSelection } from '../../shared/orcad-local-serve-selection'
import type { runProcess } from '@orca/process-host'
import { resolveLocalServeRuntime } from './serve-orcad-launch'

type RunProcess = typeof runProcess

function answering(stdout: string, code = 0): RunProcess {
  return vi.fn<RunProcess>(async () => ({
    code,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false
  }))
}

const options = {
  executable: '/Applications/Orca.app/Contents/MacOS/Orca',
  appRoot: '/Applications/Orca.app/Contents/Resources/app.asar',
  userDataPath: '/Users/u/Library/Application Support/orca',
  usesMacUpdateHandoff: false
}

describe('orca serve asking the app which host to run', () => {
  it('keeps packaged macOS on Electron without starting the app to ask', async () => {
    const run = answering('')
    expect(await resolveLocalServeRuntime({ ...options, usesMacUpdateHandoff: true }, run)).toEqual(
      {
        kind: 'electron',
        reason: expect.stringContaining('packaged macOS')
      }
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('asks the app on packaged macOS when orcad is requested explicitly', async () => {
    const selection = {
      kind: 'orcad' as const,
      runtime: '/rt/node',
      entry: '/slot/orcad.js',
      version: '1'
    }
    const run = answering(formatServeRuntimeSelection(selection))
    expect(
      await resolveLocalServeRuntime(
        { ...options, usesMacUpdateHandoff: true, env: { ORCA_SERVE_RUNTIME: 'orcad' } },
        run
      )
    ).toEqual(selection)
  })
})
