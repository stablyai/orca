export function assertMacGuiLaunchAllowed({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin' && env.CODEX_SANDBOX === 'seatbelt') {
    throw new Error(
      'Run macOS Electron/Chromium validation outside the Codex sandbox using an approved escalated command. ' +
        'Seatbelt blocks LaunchServices before app JavaScript runs, even with hidden/background windows or headless browsers. ' +
        'Keep ORCA_BACKGROUND_LAUNCH=1 and profile isolation; do not clear CODEX_SANDBOX to bypass this check.'
    )
  }
}
