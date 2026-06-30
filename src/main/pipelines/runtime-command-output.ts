export function buildPipelineCommandWithExitMarker(input: {
  command: string
  marker: string
  platform: NodeJS.Platform
}): string {
  if (input.platform === 'win32') {
    return [
      input.command,
      '$orcaPipelineExitCode = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
      `Write-Output "${input.marker}:$orcaPipelineExitCode"`
    ].join('; ')
  }

  return [
    input.command,
    '__orca_pipeline_exit_code=$?',
    `printf '\\n${input.marker}:%s\\n' "$__orca_pipeline_exit_code"`
  ].join('\n')
}

export function parsePipelineCommandExitCode(output: string, marker: string): number | null {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`${escapedMarker}:(-?\\d+)`))
  return match ? Number.parseInt(match[1], 10) : null
}
