import { readFile, stat } from 'node:fs/promises'
import { AGENT_CONFIG_LIMITS } from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { hasSecretContent, isSecretFileName } from './agent-config-secret-scan'

async function isExecutable(path: string): Promise<boolean> {
  try {
    return ((await stat(path)).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** One file's verdict: kept, kept back as a likely secret, or too big for any skill. */
export async function readItemFile(
  path: string,
  name: string
): Promise<'too-large' | 'withheld' | { bytes: Buffer; executable: boolean }> {
  const info = await stat(path)
  if (info.size > AGENT_CONFIG_LIMITS.fileBytes) {
    return 'too-large'
  }
  if (isSecretFileName(name)) {
    return 'withheld'
  }
  const bytes = await readFile(path)
  if (hasSecretContent(bytes)) {
    return 'withheld'
  }
  return { bytes, executable: await isExecutable(path) }
}
