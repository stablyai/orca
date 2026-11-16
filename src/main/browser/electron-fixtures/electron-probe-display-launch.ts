export type ElectronProbeLaunch = {
  executable: string
  args: string[]
}

export type ElectronProbeLaunchInput = {
  electronBinary: string
  electronArgs: readonly string[]
  platform: NodeJS.Platform
  display: string | undefined
}

// Reuse the inherited display to avoid concurrent xvfb-run probes racing for display numbers.
export function resolveElectronProbeLaunch({
  electronBinary,
  electronArgs,
  platform,
  display
}: ElectronProbeLaunchInput): ElectronProbeLaunch {
  if (platform !== 'linux') {
    return { executable: electronBinary, args: [...electronArgs] }
  }
  const linuxArgs = [...electronArgs, '--no-sandbox']
  if (display) {
    return { executable: electronBinary, args: linuxArgs }
  }
  return { executable: 'xvfb-run', args: ['--auto-servernum', electronBinary, ...linuxArgs] }
}
