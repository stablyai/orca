/** Windows environment names are case-insensitive, so match every casing of Chromium's pipe key. */
export function isChromiumCrashpadPipeNameKey(key: string): boolean {
  return key.toUpperCase() === 'CHROME_CRASHPAD_PIPE_NAME'
}

/** Chromium children register with this pipe; a surviving pane outlives the main process owning it (#19792). */
export function removeChromiumCrashpadPipeName(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (isChromiumCrashpadPipeNameKey(key)) {
      delete env[key]
    }
  }
}
