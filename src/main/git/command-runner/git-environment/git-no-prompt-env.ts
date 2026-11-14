/** Git for Windows may invoke GIT_ASK_YESNO for locked files; Orca's own git actions never launch that prompt. */
export function gitEnvWithoutYesNoPrompt(): { env?: NodeJS.ProcessEnv } {
  const inherited = Object.keys(process.env).filter((key) => key.toUpperCase() === 'GIT_ASK_YESNO')
  if (inherited.length === 0) {
    return {}
  }
  const env = { ...process.env }
  for (const key of inherited) {
    delete env[key]
  }
  return { env }
}
