export type HerdrListedSession = { name: string; running: boolean }

export function parseHerdrSessionList(stdout: string): HerdrListedSession[] {
  const result = JSON.parse(stdout) as {
    sessions?: { name?: unknown; running?: unknown }[]
  }
  return (result.sessions ?? []).flatMap((session) =>
    typeof session.name === 'string'
      ? [{ name: session.name, running: session.running === true }]
      : []
  )
}

export function herdrServerEnvironment(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env, ...base }
  for (const name of Object.keys(env)) {
    if (name.startsWith('HERDR_')) {
      delete env[name]
    }
  }
  return env
}
