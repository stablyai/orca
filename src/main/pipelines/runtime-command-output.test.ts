import { describe, expect, it } from 'vitest'
import {
  buildPipelineCommandWithExitMarker,
  parsePipelineCommandExitCode
} from './runtime-command-output'

describe('runtime command output', () => {
  it('wraps POSIX commands with an exit marker without exiting the shell', () => {
    expect(
      buildPipelineCommandWithExitMarker({
        command: 'test -f pipeline-smoke.txt',
        marker: '__PIPELINE_EXIT_abc__',
        platform: 'linux'
      })
    ).toBe(
      [
        'test -f pipeline-smoke.txt',
        '__orca_pipeline_exit_code=$?',
        `printf '\\n__PIPELINE_EXIT_abc__:%s\\n' "$__orca_pipeline_exit_code"`
      ].join('\n')
    )
  })

  it('wraps Windows commands with a PowerShell exit marker', () => {
    expect(
      buildPipelineCommandWithExitMarker({
        command: 'Test-Path pipeline-smoke.txt',
        marker: '__PIPELINE_EXIT_win__',
        platform: 'win32'
      })
    ).toBe(
      'Test-Path pipeline-smoke.txt; $orcaPipelineExitCode = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }; Write-Output "__PIPELINE_EXIT_win__:$orcaPipelineExitCode"'
    )
  })

  it('parses command exit codes from terminal output', () => {
    expect(
      parsePipelineCommandExitCode(
        'prompt$ test -f pipeline-smoke.txt\n__PIPELINE_EXIT_abc__:0\nprompt$',
        '__PIPELINE_EXIT_abc__'
      )
    ).toBe(0)
    expect(parsePipelineCommandExitCode('no marker', '__PIPELINE_EXIT_abc__')).toBeNull()
  })
})
