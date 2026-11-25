/** `name` as the child will see it; Windows names are case-insensitive. */
export function envValue(
  env: Readonly<Record<string, string>>,
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== 'win32') {
    return env[name]
  }
  const upper = name.toUpperCase()
  // Duplicates differing only in case: a set value wins over an empty one.
  const values = Object.entries(env)
    .filter(([key]) => key.toUpperCase() === upper)
    .map(([, value]) => value)
  return values.find((value) => value.trim()) ?? values[0]
}

/** Whether `env` itself carries a non-empty GEMINI_API_KEY: what agy will start with. */
export function envHasGeminiApiKey(env: Readonly<Record<string, string>>): boolean {
  return Boolean(envValue(env, 'GEMINI_API_KEY')?.trim())
}
