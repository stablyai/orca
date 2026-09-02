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

// Why: these probes each start a full Electron stack, and CI already runs the whole vitest
// invocation under one `xvfb-run`. Nesting a private `--auto-servernum` server per probe adds an
// X server per concurrent file and races the sibling probes for a free display number, so reuse
// the display we were handed and only own one when there is none.
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
