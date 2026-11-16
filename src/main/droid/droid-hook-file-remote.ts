import type { SFTPWrapper } from 'ssh2'
import { writeHooksJsonRemote } from '../agent-hooks/installation/configuration/hooks-json-remote'
import {
  readTextFileRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installation/remote/hook-text-files-remote'

export async function writeDroidHookFileRemote(
  sftp: SFTPWrapper,
  path: string,
  config: Record<string, unknown>
): Promise<void> {
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  const existing = await readTextFileRemote(sftp, path)
  if (existing === serialized) {
    return
  }
  if (existing !== null) {
    await writeTextFileRemoteAtomic(sftp, `${path}.bak`, existing)
  }
  await writeHooksJsonRemote(sftp, path, config, { serialized })
}
