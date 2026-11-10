import { readFile } from 'node:fs/promises'

/** Where /opt/orca/bin/orca-sandbox-env keeps the cloud session env (tmpfs; `NAME=<base64>` lines). */
export function sessionEnvFilePath(uid: number): string {
  return `/dev/shm/orca-env-${uid}/session.env`
}

/** Names only, never values. Falls back to this process's env where there is no session env file. */
export async function readSessionEnvNames(
  options: {
    uid?: number
    read?: (path: string) => Promise<string>
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<Set<string>> {
  const uid = options.uid ?? process.getuid?.()
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'))
  if (uid !== undefined) {
    try {
      const text = await read(sessionEnvFilePath(uid))
      return new Set(
        text
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => line.slice(0, line.indexOf('=')))
          .filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name))
      )
    } catch {
      // No session env file (not a cloud VM, or not written yet): use the process env.
    }
  }
  return new Set(Object.keys(options.env ?? process.env))
}
