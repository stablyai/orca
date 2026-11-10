import { readFile } from 'node:fs/promises'

/** Where /opt/orca/bin/orca-sandbox-env keeps the cloud session env (tmpfs; `NAME=<base64>` lines). */
export function sessionEnvFilePath(uid: number): string {
  return `/dev/shm/orca-env-${uid}/session.env`
}

/** Names only, never values. No file yet means the session env holds nothing; orcad's own process
 *  env is never consulted, so nothing about the host leaks through `already-set`. */
export async function readSessionEnvNames(
  options: { uid?: number; read?: (path: string) => Promise<string> } = {}
): Promise<Set<string>> {
  const uid = options.uid ?? process.getuid?.()
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'))
  if (uid === undefined) {
    return new Set()
  }
  let text: string
  try {
    text = await read(sessionEnvFilePath(uid))
  } catch {
    return new Set()
  }
  return new Set(
    text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.slice(0, line.indexOf('=')))
      .filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name))
  )
}

/** Secret requests exist only on a cloud workspace's orcad (orca-sandbox-start sets these). */
export function isCloudWorkspaceOrcad(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCA_IS_CLOUD === '1' && Boolean(env.ORCA_SANDBOX_ID?.trim())
}
